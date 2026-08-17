import type { AiAnswer, AiComparison } from '@shared/types/aiCompare'
import type { AiProviderId } from '@shared/types/aiHub'
import { createLogger } from '../logger'
import { describeProviderError, type LLMProvider } from './LLMProvider'

const log = createLogger('ai')

export interface ComparisonTarget {
  id: AiProviderId
  name: string
  local: boolean
  provider: LLMProvider
}

/**
 * Asks several providers the same question.
 *
 * Takes its targets as an argument rather than reaching for the registry, so the
 * fan-out can be exercised against stub endpoints without credentials — which is
 * the only way to test the property that matters here.
 *
 * That property is **isolation**: one provider being down, rate-limited or slow
 * must not deny the user the other answers. `allSettled` rather than `all`, and
 * every failure becomes a visible row rather than an exception that discards the
 * successes alongside it.
 */
export class AiComparisonService {
  async run(
    question: string,
    targets: readonly ComparisonTarget[],
    signal?: AbortSignal
  ): Promise<AiComparison> {
    const askedAt = Date.now()

    const settled = await Promise.allSettled(
      targets.map(async (target): Promise<AiAnswer> => {
        const started = Date.now()
        try {
          const text = await target.provider.ask(question, signal)
          return {
            provider: target.id,
            providerName: target.name,
            model: target.provider.model,
            local: target.local,
            state: 'answered',
            text,
            error: '',
            elapsedMs: Date.now() - started
          }
        } catch (error) {
          log.warn(`comparison: ${target.id} failed`, error)
          return {
            provider: target.id,
            providerName: target.name,
            model: target.provider.model,
            local: target.local,
            state: 'failed',
            text: '',
            error: describeProviderError(error),
            elapsedMs: Date.now() - started
          }
        }
      })
    )

    // Every branch above already resolves, so a rejection here would mean a bug
    // rather than a provider failure — surfaced rather than silently dropped.
    const answers = settled.map((result, index): AiAnswer => {
      if (result.status === 'fulfilled') return result.value
      const target = targets[index]!
      return {
        provider: target.id,
        providerName: target.name,
        model: target.provider.model,
        local: target.local,
        state: 'failed',
        text: '',
        error: 'Slash could not complete this request.',
        elapsedMs: 0
      }
    })

    // Fastest first: when several answers agree, the quickest is the one the
    // user will read, and ordering by provider id would be arbitrary.
    answers.sort((a, b) => a.elapsedMs - b.elapsedMs)

    log.info(
      `comparison: ${answers.filter((a) => a.state === 'answered').length}/${answers.length} answered`
    )
    return { question, askedAt, answers }
  }
}
