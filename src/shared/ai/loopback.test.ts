import { describe, expect, it } from 'vitest'
import { destinationLabel, endpointHost, loopbackVerdict } from './loopback'

describe('loopbackVerdict — addresses that are this machine', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://LOCALHOST:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://127.0.0.1/v1',
    'https://localhost:1234',
    'http://[::1]:11434/v1',
    'http://[0:0:0:0:0:0:0:1]:11434/v1'
  ])('accepts %s', (url) => {
    expect(loopbackVerdict(url)).toBe('loopback')
  })

  it('accepts the whole 127.0.0.0/8 block, not just the familiar spelling', () => {
    // 127.0.0.2 and 127.255.255.254 route here too. Recognising only 127.0.0.1
    // would call a genuinely local model remote — the safe direction, but still
    // wrong, and it would make the browser ask for consent it does not need.
    expect(loopbackVerdict('http://127.0.0.2:8080/v1')).toBe('loopback')
    expect(loopbackVerdict('http://127.255.255.254/v1')).toBe('loopback')
  })
})

describe('loopbackVerdict — addresses that are not', () => {
  it.each([
    'https://api.anthropic.com/v1',
    'https://my-gpu-box.example.net/v1',
    'http://192.168.1.50:11434/v1',
    'http://10.0.0.5:11434/v1',
    'http://172.16.0.9/v1'
  ])('refuses %s', (url) => {
    expect(loopbackVerdict(url)).toBe('remote')
  })

  it('is not fooled by a hostname that merely starts with localhost', () => {
    // `localhost.evil.example` is an ordinary remote name. A prefix test would
    // hand it the "nothing leaves this machine" badge, which is the exact
    // failure this function exists to prevent.
    expect(loopbackVerdict('http://localhost.evil.example/v1')).toBe('remote')
    expect(loopbackVerdict('http://notlocalhost/v1')).toBe('remote')
  })

  it('does not treat a private LAN address as this machine', () => {
    // A model on another box on your network is still a machine that is not
    // this one, and the copy says "this machine".
    expect(loopbackVerdict('http://192.168.0.10:11434/v1')).toBe('remote')
  })

  it('rejects a 127-lookalike that is not in the block', () => {
    expect(loopbackVerdict('http://128.0.0.1/v1')).toBe('remote')
  })

  it('reports an invalid IPv4 literal as unparseable, which callers refuse', () => {
    // `1270.0.0.1` has an octet over 255, so Node's URL parser rejects the
    // whole address rather than handing back a hostname. "Unparseable" is the
    // honest answer and every caller treats it as "do not send anything there".
    expect(loopbackVerdict('http://1270.0.0.1/v1')).toBe('unparseable')
  })

  it('accepts the shorthand form the URL parser normalises', () => {
    // `127.1` is a real way to write loopback and Node expands it to 127.0.0.1
    // before we see it. Worth pinning: if that ever changed, a local model
    // would silently start being called remote.
    expect(loopbackVerdict('http://127.1:11434/v1')).toBe('loopback')
  })
})

describe('loopbackVerdict — things that are not addresses', () => {
  it.each([null, undefined, '', '   ', 'not a url', '//no-scheme/v1', 'localhost:11434'])(
    'reports %s as unparseable',
    (value) => {
      expect(loopbackVerdict(value)).toBe('unparseable')
    }
  )

  it('refuses to judge a scheme it cannot reason about', () => {
    // Better to say "unknown" than to make a promise about a `file:` URL.
    expect(loopbackVerdict('file:///models/v1')).toBe('unparseable')
    expect(loopbackVerdict('ftp://localhost/v1')).toBe('unparseable')
  })

  it('never throws, whatever it is handed', () => {
    expect(() => loopbackVerdict('http://[malformed')).not.toThrow()
  })
})

describe('destinationLabel', () => {
  it('says the same thing in both places it is shown', () => {
    // The two surfaces that made this claim drifted apart, and that is how the
    // wrong one shipped. One function, one sentence.
    expect(destinationLabel('loopback', '127.0.0.1:11434')).toBe('stays on this machine')
    expect(destinationLabel('remote', 'api.anthropic.com')).toContain('api.anthropic.com')
  })

  it('names the host rather than saying "a third party"', () => {
    expect(destinationLabel('remote', 'my-gpu-box.example.net')).toBe(
      'sent to my-gpu-box.example.net'
    )
  })

  it('admits when it does not know', () => {
    expect(destinationLabel('unparseable', '')).toBe('destination unknown')
  })
})

describe('endpointHost', () => {
  it('includes the port, because that is what identifies a local model', () => {
    expect(endpointHost('http://127.0.0.1:11434/v1')).toBe('127.0.0.1:11434')
  })

  it('omits an absent port', () => {
    expect(endpointHost('https://api.anthropic.com/v1')).toBe('api.anthropic.com')
  })

  it('returns empty rather than throwing on nonsense', () => {
    expect(endpointHost('not a url')).toBe('')
    expect(endpointHost(null)).toBe('')
  })
})
