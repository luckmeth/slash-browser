import { describe, expect, it } from 'vitest'
import {
  DASH_LIMITS,
  expandTimeline,
  fillTemplate,
  looksLikeDash,
  parseDuration,
  parseMpd,
  qualityLabelFor,
  resolveUrl,
  selectTracks
} from './mpdParser'
import { childNamed, parseXml, XML_LIMITS } from './xml'

const MANIFEST_URL = 'https://cdn.example.test/assets/film/manifest.mpd'

/** A template-based on-demand manifest, the shape most packagers emit. */
const templateMpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0H0M20.0S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
        initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s"/>
      <Representation id="v1080" bandwidth="5200000" width="1920" height="1080" codecs="avc1.640028"/>
      <Representation id="v720" bandwidth="3100000" width="1280" height="720" codecs="avc1.4d401f"/>
      <Representation id="v360" bandwidth="700000" width="640" height="360" codecs="avc1.42c01e"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
        initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number$.m4s"/>
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2"/>
      <Representation id="a64" bandwidth="64000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`

describe('looksLikeDash', () => {
  it('recognises a manifest by its content, not its address', () => {
    // The whole point of protocol-first detection: CDNs serve manifests from
    // paths with no extension at all.
    expect(looksLikeDash(templateMpd)).toBe(true)
    expect(looksLikeDash('#EXTM3U\n#EXT-X-VERSION:3')).toBe(false)
    expect(looksLikeDash('<html><body>Not found</body></html>')).toBe(false)
  })
})

describe('parseDuration', () => {
  it('reads the forms a manifest actually uses', () => {
    expect(parseDuration('PT20.0S')).toBe(20)
    // 3600 + 23*60 + 12.5
    expect(parseDuration('PT1H23M12.5S')).toBeCloseTo(4_992.5)
    expect(parseDuration('PT2M')).toBe(120)
  })

  it('returns zero for anything it cannot read, rather than guessing', () => {
    // Zero means "length unknown" to the caller, which stops rather than
    // downloading an arbitrary number of segments.
    expect(parseDuration(undefined)).toBe(0)
    expect(parseDuration('twenty seconds')).toBe(0)
  })
})

describe('fillTemplate', () => {
  it('substitutes the identifiers a SegmentTemplate uses', () => {
    expect(
      fillTemplate('$RepresentationID$/seg-$Number$.m4s', {
        representationId: 'v1080',
        bandwidth: 5_200_000,
        number: 7
      })
    ).toBe('v1080/seg-7.m4s')
  })

  it('honours the printf width, which is easy to miss and breaks every address', () => {
    expect(
      fillTemplate('seg-$Number%05d$.m4s', { representationId: 'v', bandwidth: 0, number: 7 })
    ).toBe('seg-00007.m4s')
  })

  it('substitutes $Time$ and $Bandwidth$', () => {
    expect(
      fillTemplate('$Bandwidth$/$Time$.m4s', { representationId: 'v', bandwidth: 800, time: 12_800 })
    ).toBe('800/12800.m4s')
  })

  it('treats $$ as an escaped dollar', () => {
    expect(fillTemplate('a$$b', { representationId: 'v', bandwidth: 0 })).toBe('a$b')
  })

  it('leaves an identifier it has no value for alone', () => {
    // Better a visibly wrong URL than a silently wrong one.
    expect(fillTemplate('x-$Time$', { representationId: 'v', bandwidth: 0, number: 1 })).toBe('x-$Time$')
  })
})

describe('resolveUrl', () => {
  it('resolves relative addresses against the manifest', () => {
    expect(resolveUrl('v1080/init.mp4', MANIFEST_URL)).toBe(
      'https://cdn.example.test/assets/film/v1080/init.mp4'
    )
  })

  it('leaves an absolute address alone', () => {
    expect(resolveUrl('https://other.test/a.m4s', MANIFEST_URL)).toBe('https://other.test/a.m4s')
  })

  it('handles a root-relative address', () => {
    expect(resolveUrl('/seg/1.m4s', MANIFEST_URL)).toBe('https://cdn.example.test/seg/1.m4s')
  })
})

describe('parseMpd — SegmentTemplate', () => {
  const parsed = parseMpd(templateMpd, MANIFEST_URL)

  it('reads every video quality, best first', () => {
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.manifest.video.map((track) => track.id)).toEqual(['v1080', 'v720', 'v360'])
    expect(parsed.manifest.video.map(qualityLabelFor)).toEqual(['1080p', '720p', '360p'])
  })

  it('reads the audio tracks separately from the video', () => {
    if (!parsed.ok) return
    expect(parsed.manifest.audio.map((track) => track.id)).toEqual(['a128', 'a64'])
    expect(parsed.manifest.audio[0]?.lang).toBe('en')
  })

  it('counts segments from the period length and the segment duration', () => {
    // 20 seconds of 4-second segments is five. That count is what the manifest
    // *declares*, and it is reported separately from what gets planned.
    if (!parsed.ok) return
    expect(parsed.manifest.video[0]?.certainSegments).toBe(5)
  })

  it('plans a short look-ahead past the declared count', () => {
    // Because packagers land either side of their own estimate. ffmpeg,
    // encoding a twelve-second clip at two seconds a segment, declared six and
    // wrote seven for the audio — stopping at six truncates it. The extra
    // addresses are allowed to be absent; see `optionalFrom` in the plan.
    if (!parsed.ok) return
    expect(parsed.manifest.video[0]?.segments).toHaveLength(10)
    expect(parsed.manifest.video[0]?.segments[9]).toContain('seg-010.m4s')
  })

  it('marks an explicit segment list as certain, with nothing to look ahead to', () => {
    // Only an estimate needs a look-ahead. A list is the segments there are.
    const listed = parseMpd(
      `<MPD type="static" mediaPresentationDuration="PT8S"><Period>
         <AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1" width="1" height="1" codecs="avc1">
           <SegmentList><SegmentURL media="a.m4s"/><SegmentURL media="b.m4s"/></SegmentList>
         </Representation></AdaptationSet></Period></MPD>`,
      MANIFEST_URL
    )
    if (!listed.ok) return
    expect(listed.manifest.video[0]?.certainSegments).toBeNull()
    expect(listed.manifest.video[0]?.segments).toHaveLength(2)
  })

  it('builds absolute segment addresses with the padding the template asked for', () => {
    if (!parsed.ok) return
    expect(parsed.manifest.video[0]?.segments[0]).toBe(
      'https://cdn.example.test/assets/film/v1080/seg-001.m4s'
    )
    expect(parsed.manifest.video[0]?.segments[4]).toBe(
      'https://cdn.example.test/assets/film/v1080/seg-005.m4s'
    )
  })

  it('keeps the initialization segment, without which the file will not play', () => {
    if (!parsed.ok) return
    expect(parsed.manifest.video[0]?.initSegment).toBe(
      'https://cdn.example.test/assets/film/v1080/init.mp4'
    )
  })
})

describe('parseMpd — SegmentList', () => {
  const listMpd = `<MPD type="static" mediaPresentationDuration="PT12S">
    <BaseURL>https://cdn.example.test/base/</BaseURL>
    <Period>
      <AdaptationSet mimeType="video/mp4">
        <Representation id="v1" bandwidth="900000" width="854" height="480" codecs="avc1.42c01e">
          <SegmentList duration="4">
            <Initialization sourceURL="init.mp4"/>
            <SegmentURL media="seg1.m4s"/>
            <SegmentURL media="seg2.m4s"/>
            <SegmentURL media="https://other.test/seg3.m4s"/>
          </SegmentList>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`

  it('reads an explicit segment list, absolute and relative alike', () => {
    const parsed = parseMpd(listMpd, MANIFEST_URL)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.manifest.video[0]?.segments).toEqual([
      'https://cdn.example.test/base/seg1.m4s',
      'https://cdn.example.test/base/seg2.m4s',
      'https://other.test/seg3.m4s'
    ])
    expect(parsed.manifest.video[0]?.initSegment).toBe('https://cdn.example.test/base/init.mp4')
  })

  it('resolves against a document-level BaseURL rather than the manifest address', () => {
    // Four levels of BaseURL inheritance is where DASH parsers usually go wrong,
    // and the failure is segment URLs that are well-formed and point at nothing.
    const parsed = parseMpd(listMpd, MANIFEST_URL)
    if (!parsed.ok) return
    expect(parsed.manifest.video[0]?.segments[0]).toContain('/base/')
  })
})

describe('parseMpd — SegmentTimeline', () => {
  const timelineMpd = `<MPD type="static" mediaPresentationDuration="PT10S">
    <Period>
      <AdaptationSet mimeType="video/mp4">
        <SegmentTemplate timescale="1000" initialization="init.mp4" media="s-$Time$.m4s">
          <SegmentTimeline>
            <S t="0" d="2000" r="2"/>
            <S d="1500"/>
          </SegmentTimeline>
        </SegmentTemplate>
        <Representation id="v" bandwidth="1000" width="640" height="360" codecs="avc1"/>
      </AdaptationSet>
    </Period>
  </MPD>`

  it('expands repeats into individual start times', () => {
    // `r="2"` means two *more*, so three segments — an off-by-one here drops or
    // duplicates a segment and corrupts everything after it.
    const parsed = parseMpd(timelineMpd, MANIFEST_URL)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.manifest.video[0]?.segments.map((url) => url.split('/').pop())).toEqual([
      's-0.m4s',
      's-2000.m4s',
      's-4000.m4s',
      's-6000.m4s'
    ])
  })

  it('stops at the cap rather than expanding a hostile repeat count', () => {
    const parsedTimeline = parseXml(
      '<SegmentTimeline><S t="0" d="1" r="999999999"/></SegmentTimeline>'
    )
    expect(parsedTimeline.ok).toBe(true)
    if (!parsedTimeline.ok) return
    expect(expandTimeline(parsedTimeline.root, 10)).toHaveLength(10)
  })
})

describe('parseMpd — SegmentBase and bare representations', () => {
  it('treats a single indexed file as the one thing to download', () => {
    const baseMpd = `<MPD type="static" mediaPresentationDuration="PT30S">
      <Period><AdaptationSet mimeType="video/mp4">
        <Representation id="v" bandwidth="500000" width="640" height="360" codecs="avc1">
          <BaseURL>film.mp4</BaseURL>
          <SegmentBase indexRange="0-999"/>
        </Representation>
      </AdaptationSet></Period>
    </MPD>`
    const parsed = parseMpd(baseMpd, MANIFEST_URL)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.manifest.video[0]?.segments).toEqual([
      'https://cdn.example.test/assets/film/film.mp4'
    ])
  })
})

describe('parseMpd — what it refuses, and whether it says why', () => {
  it('refuses a live manifest by name', () => {
    const live = `<MPD type="dynamic"><Period><AdaptationSet mimeType="video/mp4">
      <Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`
    const parsed = parseMpd(live, MANIFEST_URL)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('Live MPEG-DASH streams are not currently supported')
  })

  it('refuses a multi-period manifest by name', () => {
    const multi = `<MPD type="static"><Period/><Period/></MPD>`
    const parsed = parseMpd(multi, MANIFEST_URL)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('Multi-period')
  })

  it('excludes encrypted tracks and explains rather than offering a broken file', () => {
    const drm = `<MPD type="static" mediaPresentationDuration="PT10S"><Period>
      <AdaptationSet mimeType="video/mp4">
        <ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"/>
        <SegmentTemplate timescale="1" duration="2" media="s-$Number$.m4s"/>
        <Representation id="v" bandwidth="1000" width="640" height="360" codecs="avc1"/>
      </AdaptationSet></Period></MPD>`
    const parsed = parseMpd(drm, MANIFEST_URL)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('encrypted')
    expect(parsed.reason).toContain('does not work around')
  })

  it('refuses something that is not a manifest at all', () => {
    expect(parseMpd('<html><body>404</body></html>', MANIFEST_URL).ok).toBe(false)
  })

  it('survives a malformed manifest instead of throwing', () => {
    const broken = '<MPD type="static"><Period><AdaptationSet><Representation id="v"'
    expect(() => parseMpd(broken, MANIFEST_URL)).not.toThrow()
    expect(parseMpd(broken, MANIFEST_URL).ok).toBe(false)
  })

  it('refuses a manifest with a template but no length to count against', () => {
    // Without a duration there is no way to know how many segments exist, and
    // guessing downloads half a film or requests a thousand missing addresses.
    const noDuration = `<MPD type="static"><Period><AdaptationSet mimeType="video/mp4">
      <SegmentTemplate timescale="1" duration="2" media="s-$Number$.m4s"/>
      <Representation id="v" bandwidth="1" width="1" height="1" codecs="avc1"/>
    </AdaptationSet></Period></MPD>`
    expect(parseMpd(noDuration, MANIFEST_URL).ok).toBe(false)
  })
})

describe('selectTracks', () => {
  it('takes the best video and the best audio when nothing is chosen', () => {
    const parsed = parseMpd(templateMpd, MANIFEST_URL)
    if (!parsed.ok) return
    const chosen = selectTracks(parsed.manifest)
    expect(chosen.video?.id).toBe('v1080')
    expect(chosen.audio?.id).toBe('a128')
  })

  it('honours the quality the user picked', () => {
    const parsed = parseMpd(templateMpd, MANIFEST_URL)
    if (!parsed.ok) return
    expect(selectTracks(parsed.manifest, 'v360').video?.id).toBe('v360')
  })

  it('falls back to the best rather than nothing when the choice has gone', () => {
    const parsed = parseMpd(templateMpd, MANIFEST_URL)
    if (!parsed.ok) return
    expect(selectTracks(parsed.manifest, 'no-such-id').video?.id).toBe('v1080')
  })
})

describe('the XML reader’s own limits', () => {
  it('refuses a document type declaration outright', () => {
    // Entity expansion is the billion-laughs attack. A manifest that needs a
    // DTD is not one worth reading.
    const bomb = `<!DOCTYPE lolz [<!ENTITY lol "lol">]><MPD type="static"/>`
    const parsed = parseXml(bomb)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('document type')
  })

  it('refuses a document nested past the depth cap', () => {
    const deep = '<a>'.repeat(XML_LIMITS.maxDepth + 5)
    const parsed = parseXml(deep)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('nested too deeply')
  })

  it('refuses a document with too many elements', () => {
    const wide = `<root>${'<n/>'.repeat(XML_LIMITS.maxNodes + 10)}</root>`
    const parsed = parseXml(wide)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('too many elements')
  })

  it('refuses a document larger than the size cap', () => {
    const parsed = parseXml('x'.repeat(XML_LIMITS.maxLength + 1))
    expect(parsed.ok).toBe(false)
  })

  it('expands only the predefined entities', () => {
    const parsed = parseXml('<a href="x&amp;y&custom;"/>')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.root.attributes['href']).toBe('x&y&custom;')
  })

  it('reads text content, which is where BaseURL lives', () => {
    const parsed = parseXml('<MPD><BaseURL>https://cdn.test/x/</BaseURL></MPD>')
    if (!parsed.ok) return
    expect(childNamed(parsed.root, 'BaseURL')?.text).toBe('https://cdn.test/x/')
  })

  it('caps the number of segments a single representation can plan', () => {
    expect(DASH_LIMITS.maxSegments).toBeLessThanOrEqual(50_000)
  })
})

describe('a manifest ffmpeg actually wrote', () => {
  // Not a hand-written fixture. This is the exact output of
  // `ffmpeg -f dash -seg_duration 2 -use_template 1 -use_timeline 0`, which is
  // what the end-to-end probe serves — and it is the shape that proved the
  // count is only an estimate: ffmpeg declared six segments, wrote six for the
  // video and seven for the audio.
  const real = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
	xmlns="urn:mpeg:dash:schema:mpd:2011"
	xmlns:xlink="http://www.w3.org/1999/xlink"
	xsi:schemaLocation="urn:mpeg:DASH:schema:MPD:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd"
	profiles="urn:mpeg:dash:profile:isoff-live:2011"
	type="static"
	mediaPresentationDuration="PT12.0S"
	maxSegmentDuration="PT2.0S"
	minBufferTime="PT4.0S">
	<ProgramInformation>
	</ProgramInformation>
	<ServiceDescription id="0">
	</ServiceDescription>
	<Period id="0" start="PT0.0S">
		<AdaptationSet id="0" contentType="video" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" frameRate="15/1" maxWidth="320" maxHeight="240" par="4:3" lang="und">
			<Representation id="0" mimeType="video/mp4" codecs="avc1.64000c" bandwidth="39996" width="320" height="240" sar="1:1">
				<SegmentTemplate timescale="1000000" duration="2000000" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
				</SegmentTemplate>
			</Representation>
		</AdaptationSet>
		<AdaptationSet id="1" contentType="audio" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" lang="und">
			<Representation id="1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="69222" audioSamplingRate="44100">
				<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="1" />
				<SegmentTemplate timescale="1000000" duration="2000000" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
				</SegmentTemplate>
			</Representation>
		</AdaptationSet>
	</Period>
</MPD>
`
  const parsed = parseMpd(real, 'http://127.0.0.1:8080/manifest.mpd')

  it('reads both representations', () => {
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.manifest.video).toHaveLength(1)
    expect(parsed.manifest.audio).toHaveLength(1)
  })

  it('knows how many segments the manifest actually declared', () => {
    // Six: twelve seconds at two seconds a segment. Without this the look-ahead
    // has no idea where the estimate ends, so every extra address it plans
    // fails the download instead of ending it.
    if (!parsed.ok) return
    expect(parsed.manifest.video[0]?.certainSegments).toBe(6)
    expect(parsed.manifest.audio[0]?.certainSegments).toBe(6)
  })

  it('builds the addresses ffmpeg actually wrote', () => {
    if (!parsed.ok) return
    expect(parsed.manifest.video[0]?.initSegment).toBe('http://127.0.0.1:8080/init-stream0.m4s')
    expect(parsed.manifest.video[0]?.segments[0]).toBe(
      'http://127.0.0.1:8080/chunk-stream0-00001.m4s'
    )
    expect(parsed.manifest.audio[0]?.segments[0]).toBe(
      'http://127.0.0.1:8080/chunk-stream1-00001.m4s'
    )
  })

  it('plans past the declared count so the seventh audio segment is not lost', () => {
    if (!parsed.ok) return
    expect(parsed.manifest.audio[0]?.segments.length).toBeGreaterThan(6)
    expect(parsed.manifest.audio[0]?.segments[6]).toContain('chunk-stream1-00007.m4s')
  })
})
