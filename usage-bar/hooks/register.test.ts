import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { cellWidth } from './register'

const USAGE = JSON.stringify({
  limits: [
    { kind: 'weekly_all', percent: 2, resets_at: '1970-01-07T22:00:00Z' },
    {
      kind: 'weekly_scoped',
      percent: 95,
      resets_at: '1970-01-07T22:00:00Z',
      scope: { model: { display_name: 'Fable 5' } },
    },
  ],
})

test('shows session, week and fable gauges', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: USAGE } }))
  on('fs.read', () => ({ value: 'one\ntwo\nthree\n' }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('ls-files')
        ? 'new.txt\0'
        : ' 2 files changed, 9 insertions(+), 1 deletion(-)\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  let effortLevel = 'medium'
  on('settings.read', () => ({
    value: { effortLevel: 'xhigh', modelSettings: { 'claude-opus-5': { effortLevel: 'max' }, 'claude-opus-5-5': { effortLevel } } },
  }))
  on('command.run', () => ({ text: '' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23.5 },
        { kind: 'seven_day', percentUsed: 71 },
      ],
    },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))

  await $.session.measure({
    context: { window: 200000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23.5 },
      { kind: 'seven_day', percentUsed: 71 },
    ],
    changed: ['rateLimits'],
  })
  // A hook asks for the refresh and does not wait for it: let it finish.
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-bar',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false } as never,
    })
    // Engine figures win over the statusline's for session and week.
    expect(await ui.find({ type: 'Text', text: /^24%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^71%$/ })).toBeDefined()
    // Fable comes from the usage endpoint's limits[], with its reset delay.
    expect(await ui.find({ type: 'Text', text: /^95%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↻ 6d22h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Projects/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Opus-5\.5$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\(medium\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^3 files$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ \+12$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ -1$/ })).toBeDefined()
    // Two lines: project, model and effort above; every figure below.
    const head = await ui.find({ key: 'head' })
    const figures = await ui.find({ key: 'figures' })
    expect(JSON.stringify(head)).toContain('Opus-5.5')
    expect(JSON.stringify(head)).not.toContain('⌛')
    expect(JSON.stringify(figures)).toContain('⌛')
    expect(JSON.stringify(figures)).toContain('files')
    expect(JSON.stringify(figures)).not.toContain('Projects')
    await ui.unmount()
  }

  // /effort shows at once, without waiting for a turn.
  effortLevel = 'high'
  await $.command.run({ command: 'effort', args: 'high' } as never)
  await clock.advance(0)
  const ui = await $.ui.mount({
    plugin: 'usage-bar',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false } as never,
  })
  expect(await ui.find({ type: 'Text', text: /\(high\)/ })).toBeDefined()
  await ui.unmount()
})

test('asks the usage endpoint once for every session and keeps a refused answer', async ($, on) => {
  let requests = 0
  let isRefused = false
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => {
    requests += 1

    return {
      value: isRefused
        ? { status: 429, ok: false, headers: {}, text: '{}' }
        : { status: 200, ok: true, headers: {}, text: USAGE },
    }
  })
  const measure = async () => {
    await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['rateLimits'] })
    await clock.advance(0)
  }
  const shown = async () => {
    const ui = await $.ui.mount({
      plugin: 'usage-bar',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false } as never,
    })
    const found = await ui.find({ type: 'Text', text: /^95%$/ })
    await ui.unmount()

    return found
  }

  await measure()
  await measure()
  expect(requests).toBe(1)
  expect(await shown()).toBeDefined()

  // Session and week come from the endpoint too, ahead of the engine's figures.
  const ui = await $.ui.mount({
    plugin: 'usage-bar',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false } as never,
  })
  expect(await ui.find({ type: 'Text', text: /^2%$/ })).toBeDefined()
  await ui.unmount()

  // 30 seconds on, the next request is refused: the last figure stays.
  isRefused = true
  await clock.advance(30000)
  await measure()
  expect(requests).toBe(2)
  expect(await shown()).toBeDefined()

  // And nothing is asked again before the backoff ends.
  await clock.advance(30000)
  await measure()
  expect(requests).toBe(2)
})

test('refreshes by itself every 30 seconds', async ($, on) => {
  let reads = 0
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => {
    reads += 1

    return { value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }
  })
  on('session.authorize', () => ({ value: null }))
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)

  await $.session.start({ source: 'startup', cwd: '/home/me/Projects' } as never)
  await clock.advance(0)
  const atStart = reads
  expect(atStart).toBeGreaterThan(0)

  // No figure for Fable (no credential): the stand-in 0% is grey, not green.
  const ui = await $.ui.mount({
    plugin: 'usage-bar',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false } as never,
  })
  const zeros = await ui.findAll({ type: 'Text', text: /^0%$/ })
  expect(zeros.length).toBeGreaterThan(0)
  expect(zeros.every(z => z.props.color === '#8a8f98')).toBe(true)
  await ui.unmount()

  await clock.advance(30000)
  expect(reads).toBe(atStart + 1)
  await clock.advance(60000)
  expect(reads).toBe(atStart + 3)
})

test('never holds a hook up, survives a failed first refresh and gives up a silent request', async ($, on) => {
  let reads = 0
  let requests = 0
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => {
    reads += 1

    // The very first reading fails.
    if (reads === 1) {
      throw new Error('not ready')
    }

    return { value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [] } }
  })
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  // The usage endpoint never answers.
  on('http.fetch', () => {
    requests += 1

    return new Promise<never>(() => undefined)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  const shows = async (text: RegExp) => {
    const ui = await $.ui.mount({
      plugin: 'usage-bar',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false } as never,
    })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()

    return found !== undefined
  }

  // The start returns although nothing has been read yet.
  await $.session.start({ source: 'startup', cwd: '/home/me/Projects' } as never)
  await clock.advance(0)
  expect(reads).toBe(1)

  // The timer was set before that failed reading: the next tick reads again,
  // and waits on the silent endpoint.
  await clock.advance(30000)
  expect(reads).toBe(2)
  expect(requests).toBe(1)

  // Ten seconds on the request is given up and the band is drawn without it.
  await clock.advance(10000)
  expect(await shows(/^42%$/)).toBe(true)
})

test('drops an engine figure from before the window reset', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: USAGE } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  // The engine still holds 80% for a week that reset a minute ago; the
  // endpoint already reports the new week at 2%.
  await clock.advance(60000)
  const rateLimits = [{ kind: 'seven_day', percentUsed: 80, resetsAt: '1970-01-01T00:00:00Z' }]
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits },
  }))

  await $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] })
  await clock.advance(0)

  const ui = await $.ui.mount({
    plugin: 'usage-bar',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false } as never,
  })
  expect(await ui.find({ type: 'Text', text: /^80%$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^2%$/ })).toBeDefined()
  await ui.unmount()
})

test('counts what is staged in a repository with no commit yet', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: null }))
  on('process.run', (_, e) => ({
    value: {
      // `git diff HEAD` fails without a commit; `--cached` and `ls-files` work.
      exitCode: e.argv.includes('HEAD') ? 128 : 0,
      stdout: e.argv.includes('--cached') ? ' 1 file changed, 4 insertions(+)\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })
  await clock.advance(0)
  const ui = await $.ui.mount({
    plugin: 'usage-bar',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false } as never,
  })
  expect(await ui.find({ type: 'Text', text: /^1 file$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ \+4$/ })).toBeDefined()
  await ui.unmount()
})

test('shows the Fable reset only when it differs from the week reset', async ($, on) => {
  let fableReset = '1970-01-07T22:00:00Z'
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        limits: [
          { kind: 'weekly_all', percent: 2, resets_at: '1970-01-07T22:00:00Z' },
          {
            kind: 'weekly_scoped',
            percent: 95,
            resets_at: fableReset,
            scope: { model: { display_name: 'Fable' } },
          },
        ],
      }),
    },
  }))
  const resets = async () => {
    await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['rateLimits'] })
    await clock.advance(0)
    const ui = await $.ui.mount({
      plugin: 'usage-bar',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false } as never,
    })
    const found = (await ui.findAll({ type: 'Text', text: /↻/ })).map(t => t.text)
    // Fable's percentage stays whatever its reset.
    expect(await ui.find({ type: 'Text', text: /^95%$/ })).toBeDefined()
    await ui.unmount()

    return found
  }

  // Same reset as the week: said once, on the week.
  expect(await resets()).toEqual([' ↻ 6d22h'])

  // Fable resets a day earlier: both are said.
  fableReset = '1970-01-06T22:00:00Z'
  await clock.advance(30000)
  expect(await resets()).toEqual([' ↻ 6d22h', ' ↻ 5d22h'])
})

const RUN = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const BAND = { plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt' } as const
const BRANCH_BLUE = '#7f9fc4'

test('shows the branch and the unpushed commits on the head line', async ($, on) => {
  let ahead = 2
  let behind = 0
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: null }))
  on('process.run', (_, e) =>
    e.argv.includes('status')
      ? RUN(
          [
            '# branch.oid 1f2e3d',
            '# branch.head feature/bar',
            '# branch.upstream origin/feature/bar',
            `# branch.ab +${ahead} -${behind}`,
            '1 .M N... 100644 100644 100644 1f2e3d 1f2e3d a.txt',
            '',
          ].join('\n'),
        )
      : RUN(''),
  )
  const headLine = async () => {
    await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })
    await clock.advance(0)
    const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const branch = await ui.find({ type: 'Text', text: /^feature\/bar$/ })
    const line = JSON.stringify(await ui.find({ key: 'head' }))
    await ui.unmount()

    return { texts, branch, line }
  }

  // project | branch ↑2 | model: the branch sits between the two, in grey-blue.
  let shown = await headLine()
  expect(shown.branch).toBeDefined()
  expect(shown.branch?.props.color).toBe(BRANCH_BLUE)
  expect(shown.texts).toContain(' ↑2')
  expect(shown.line.indexOf('Projects')).toBeLessThan(shown.line.indexOf('feature/bar'))
  expect(shown.line.indexOf('feature/bar')).toBeLessThan(shown.line.indexOf('Opus-5.5'))

  // Everything pushed: the branch alone.
  ahead = 0
  shown = await headLine()
  expect(shown.branch).toBeDefined()
  expect(shown.texts.some(t => typeof t === 'string' && t.includes('↑'))).toBe(false)
  expect(shown.texts.some(t => typeof t === 'string' && t.includes('↓'))).toBe(false)

  // Behind its upstream: the commits to pull, after those to push.
  ahead = 2
  behind = 3
  shown = await headLine()
  expect(shown.texts).toContain(' ↓3')
  expect(shown.texts.indexOf(' ↑2')).toBe(shown.texts.indexOf(' ↓3') - 1)
  expect(shown.line).toContain(JSON.stringify(' ↓3'))

  // Behind alone.
  ahead = 0
  shown = await headLine()
  expect(shown.texts).toContain(' ↓3')
  expect(shown.texts.some(t => typeof t === 'string' && t.includes('↑'))).toBe(false)
})

test('shows no branch outside a repository or on an unreadable answer', async ($, on) => {
  let answer: () => ReturnType<typeof RUN> = () => RUN('fatal: not a git repository\n', 128)
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: { effortLevel: 'high' } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: null }))
  on('process.run', () => answer())
  const headLine = async () => {
    await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })
    await clock.advance(0)
    const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
    const line = JSON.stringify(await ui.find({ key: 'head' }))
    await ui.unmount()

    return line
  }
  // No branch, and the rest of the head line is drawn all the same.
  const expectNoBranch = (line: string) => {
    expect(line).not.toContain(BRANCH_BLUE)
    expect(line).not.toContain('↑')
    expect(line).toContain('Projects')
    expect(line).toContain('Opus-5.5')
    expect(line).toContain('(high)')
  }

  // Outside a repository.
  expectNoBranch(await headLine())

  // An answer that is not `git status`'s, although the command succeeded.
  answer = () => RUN(' 2 files changed, 9 insertions(+), 1 deletion(-)\n')
  expectNoBranch(await headLine())
  answer = () => RUN('# branch.head two words\n# branch.ab +x -0\n')
  expectNoBranch(await headLine())

  // A detached HEAD is no branch.
  answer = () => RUN('# branch.oid 1f2e3d\n# branch.head (detached)\n')
  expectNoBranch(await headLine())

  // No git at all on the machine.
  answer = () => {
    throw new Error('spawn git ENOENT')
  }
  expectNoBranch(await headLine())

  // And a branch shown before leaves once the answer has none.
  answer = () => RUN('# branch.head main\n# branch.ab +1 -0\n')
  expect(await headLine()).toContain(BRANCH_BLUE)
  answer = () => RUN('', 128)
  expectNoBranch(await headLine())
})

test('marks a Claude figure kept through a refused request', async ($, on) => {
  let isRefused = false
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [] },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({
    value: isRefused
      ? { status: 429, ok: false, headers: {}, text: '{}' }
      : { status: 200, ok: true, headers: {}, text: USAGE },
  }))
  const tildes = async (wait: number) => {
    await clock.advance(wait)
    await $.session.measure({ context: { window: 200000, percent: 42 }, rateLimits: [], changed: ['rateLimits'] })
    await clock.advance(0)
    const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
    const found = await ui.findAll({ type: 'Text', text: /^~$/ })
    // The figures themselves stay bare, marked or not.
    expect(await ui.find({ type: 'Text', text: /^2%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^95%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
    await ui.unmount()

    return found.length
  }

  // A fresh answer: nothing is marked.
  expect(await tildes(0)).toBe(0)

  // The next request is refused: the week and Fable are the last ones known.
  // The session has no figure and the context is the engine's: neither is marked.
  isRefused = true
  expect(await tildes(30000)).toBe(2)

  // Within the backoff nothing is asked, and the mark stays.
  expect(await tildes(30000)).toBe(2)

  // The endpoint answers again: the mark leaves.
  isRefused = false
  expect(await tildes(120000)).toBe(0)
})

test('does not mark a figure the engine reports higher', async ($, on) => {
  let isRefused = false
  let rateLimits: { kind: string; percentUsed: number }[] = []
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({
    value: isRefused
      ? { status: 429, ok: false, headers: {}, text: '{}' }
      : { status: 200, ok: true, headers: {}, text: USAGE },
  }))
  const band = async (wait: number) => {
    await clock.advance(wait)
    await $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] } as never)
    await clock.advance(0)
    const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
    const figures = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()

    return figures
  }

  expect(await band(0)).not.toContain('~')

  // The endpoint is refused while the engine reports the week at 71%, above
  // the 2% kept: that figure is the engine's own, and fresh.
  isRefused = true
  rateLimits = [{ kind: 'seven_day', percentUsed: 71 }]
  const figures = await band(30000)
  expect(figures).toContain('71%')
  expect(figures).not.toContain('2%')
  // Fable's 95% is still the kept one: the only mark, right before it.
  expect(figures.filter(t => t === '~').length).toBe(1)
  expect(figures[figures.indexOf('95%') - 1]).toBe('~')
  expect(figures[figures.indexOf('71%') - 1]).not.toBe('~')
})

test('shows the engine session window over one kept from before a refusal', async ($, on) => {
  let isRefused = false
  let rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[] = []
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  // No session window was open when the endpoint last answered.
  const idle = JSON.stringify({
    limits: [
      { kind: 'session', percent: 0, resets_at: null, is_active: false },
      { kind: 'weekly_all', percent: 38, resets_at: '1970-01-07T22:00:00Z' },
    ],
  })
  on('http.fetch', () => ({
    value: isRefused
      ? { status: 429, ok: false, headers: {}, text: '{}' }
      : { status: 200, ok: true, headers: {}, text: idle },
  }))
  const band = async (wait: number) => {
    await clock.advance(wait)
    await $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] } as never)
    await clock.advance(0)
    const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
    const figures = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()

    return figures
  }

  expect(await band(0)).not.toContain('~')

  // The endpoint is refused and a window opened since: the engine reports it
  // at 0% as the kept answer does, with the reset the kept one cannot have.
  isRefused = true
  rateLimits = [{ kind: 'five_hour', percentUsed: 0, resetsAt: '1970-01-01T04:00:00Z' }]
  const figures = await band(30000)
  // The week alone is a kept figure.
  expect(figures.filter(t => t === '~').length).toBe(1)
  expect(figures[figures.indexOf('38%') - 1]).toBe('~')
  expect(figures[figures.indexOf('0%') - 1]).not.toBe('~')
  expect(figures.join('|')).toContain('⌛ |0%| ↻ 4h00')
})

test('a session without a Claude credential asks nothing and leaves the shared answer alone', async ($, on) => {
  const clock = mock.clock(on)
  const entry = {
    nextAt: 0,
    fetchedAt: 0,
    limits: [{ kind: 'weekly_all', percent: 38, resets_at: '1970-01-07T22:00:00Z' }],
  }
  const kept = new Map<string, unknown>([['claude-usage', entry]])
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    kept.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [...kept.keys()] }))
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  // An agent behind a gateway: no first-party credential.
  on('session.authorize', () => ({ value: null }))
  let requests = 0
  on('http.fetch', () => {
    requests += 1

    return { value: { status: 429, ok: false, headers: {}, text: '{}' } }
  })

  for (const wait of [0, 30000, 120000]) {
    await clock.advance(wait)
    await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['rateLimits'] } as never)
    await clock.advance(0)
  }

  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  const figures = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  // The slot stays free for a session that can ask, and the figure another
  // session read is shown as it is.
  expect(requests).toBe(0)
  expect(kept.get('claude-usage')).toEqual(entry)
  expect(figures).toContain('38%')
  expect(figures).not.toContain('~')
})

test('waits longer on its own at each failed request in a row', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  let isRefused = true
  let requests = 0
  on('http.fetch', () => {
    requests += 1

    return {
      value: isRefused
        ? { status: 429, ok: false, headers: {}, text: '{}' }
        : { status: 200, ok: true, headers: {}, text: USAGE },
    }
  })
  const asked = async (wait: number) => {
    await clock.advance(wait)
    await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['rateLimits'] } as never)
    await clock.advance(0)

    return requests
  }

  // Refused at 0 s, and again at 120 s once the shared wait is over.
  expect(await asked(0)).toBe(1)
  expect(await asked(120000)).toBe(2)
  // At 240 s the shared wait is over again, but this session's own is twice
  // as long after two failures: the slot is left to the other sessions.
  expect(await asked(120000)).toBe(2)
  // At 360 s it asks again; an answer ends its own wait.
  isRefused = false
  expect(await asked(120000)).toBe(3)
  expect(await asked(30000)).toBe(4)
})

test('shows what the session cost, and nothing when the host keeps no ledger', async ($, on) => {
  let cost: { usd: number } | undefined = { usd: 1.234 }
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [], cost },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: null }))
  const band = async () => {
    await $.session.measure({ context: { window: 200000, percent: 42 }, rateLimits: [], changed: ['context'] })
    await clock.advance(0)
    const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
    const amount = await ui.find({ type: 'Text', text: /^Σ \$/ })
    const figures = JSON.stringify(await ui.find({ key: 'figures' }))
    await ui.unmount()

    return { amount, figures }
  }

  // In grey, after the context.
  let shown = await band()
  expect(shown.amount?.text).toBe('Σ $1.23')
  expect(shown.amount?.props.color).toBe('#8a8f98')
  expect(shown.figures.indexOf('42%')).toBeLessThan(shown.figures.indexOf('Σ $1.23'))

  // No ledger: no segment.
  cost = undefined
  shown = await band()
  expect(shown.amount).toBeUndefined()
  expect(shown.figures).not.toContain('$')

  // An amount that is no number is no cost either.
  cost = { usd: Number.NaN }
  shown = await band()
  expect(shown.amount).toBeUndefined()
  expect(shown.figures).not.toContain('NaN')
})

// What the band must print for a reset, from the same local-time API it uses:
// the assertions hold in any time zone.
const RESET_TIME = (iso: string, now: number) => {
  const at = new Date(iso)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][at.getDay()]

  return at.getTime() - now < 86400000 ? ` ↻ ${time}` : ` ↻ ${day} ${time}`
}

test('shows the reset as a time of day when asked', { options: { resetStyle: 'time' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  // The session resets in three and a half hours, the week in six days.
  const rateLimits = [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '1970-01-01T03:30:00Z' }]
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: USAGE } }))

  await $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  const resets = (await ui.findAll({ type: 'Text', text: /↻/ })).map(t => t.text)
  await ui.unmount()

  // Under 24 hours the time alone, past it the day too; never a delay.
  expect(resets).toEqual([
    RESET_TIME('1970-01-01T03:30:00Z', 0),
    RESET_TIME('1970-01-07T22:00:00Z', 0),
  ])
  expect(resets[0]).toMatch(/^ ↻ \d\d:\d\d$/)
  expect(resets[1]).toMatch(/^ ↻ (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/)
})

for (const resetStyle of ['delay', 'time'] as const) {
  test(
    `says the Fable reset once when it equals the week's, in either style (${resetStyle})`,
    { options: { resetStyle } },
    async ($, on) => {
      let fableReset = '1970-01-07T22:00:00Z'
      const clock = mock.clock(on)
      mock.store(on)
      on('session.cwd', () => ({ value: '/home/me/Projects' }))
      on('session.model', () => ({ value: 'claude-opus-5-5' }))
      on('settings.read', () => ({ value: {} }))
      on('session.usage', () => ({
        value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
      }))
      on('session.measure', (_, e) => ({ changed: e.changed }))
      on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
      on('http.fetch', () => ({
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({
            limits: [
              { kind: 'weekly_all', percent: 2, resets_at: '1970-01-07T22:00:00Z' },
              {
                kind: 'weekly_scoped',
                percent: 95,
                resets_at: fableReset,
                scope: { model: { display_name: 'Fable' } },
              },
            ],
          }),
        },
      }))
      const resets = async () => {
        await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['rateLimits'] })
        await clock.advance(0)
        const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
        const found = (await ui.findAll({ type: 'Text', text: /↻/ })).map(t => t.text)
        expect(await ui.find({ type: 'Text', text: /^95%$/ })).toBeDefined()
        await ui.unmount()

        return found
      }
      const week =
        resetStyle === 'time' ? (now: number) => RESET_TIME('1970-01-07T22:00:00Z', now) : () => ' ↻ 6d22h'

      // Same reset as the week: said once, on the week.
      expect(await resets()).toEqual([week(0)])

      // Fable resets a day earlier: both are said.
      fableReset = '1970-01-06T22:00:00Z'
      await clock.advance(30000)
      expect(await resets()).toEqual([
        week(30000),
        resetStyle === 'time' ? RESET_TIME(fableReset, 30000) : ' ↻ 5d22h',
      ])
    },
  )
}

test('hides the session cost when showCost is off', { options: { showCost: false } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [], cost: { usd: 1.234 } },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: null }))

  await $.session.measure({ context: { window: 200000, percent: 42 }, rateLimits: [], changed: ['context'] })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$/ })).toBeUndefined()
  await ui.unmount()
})

// `kind`: the window reported, the session's by default. `contextPercent`:
// how full the context is, when the engine says it.
type Quota = { percent: number; resetsAt: string; refusesToasts?: boolean; kind?: string; contextPercent?: number }

// A Claude session whose engine reports the session window as `quota` says it
// at each refresh: the toasts it raised, a refresh, and the band's texts.
const WATCH = ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], quota: Quota) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  const rateLimits = () => [
    { kind: quota.kind ?? 'five_hour', percentUsed: quota.percent, resetsAt: quota.resetsAt },
  ]
  const context = () => ({
    window: 200000,
    ...(quota.contextPercent === undefined ? {} : { percent: quota.contextPercent }),
  })
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: context(), rateLimits: rateLimits() },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: null }))
  on('ui.toast', (_, e) => {
    if (quota.refusesToasts) {
      throw new Error('no surface')
    }

    toasts.push(e.text)

    return { value: undefined }
  })
  const refresh = async (wait = 0) => {
    await clock.advance(wait)
    await $.session.measure({ context: context(), rateLimits: rateLimits(), changed: ['rateLimits'] })
    await clock.advance(0)
  }
  const texts = async () => {
    const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
    const found = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()

    return found
  }

  return { toasts, refresh, texts, clock }
}

test('toasts once when a quota crosses a threshold', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 49, resetsAt: '1970-01-01T05:00:00Z' }
  const { toasts, refresh } = WATCH($, on, quota)

  await refresh()
  expect(toasts).toEqual([])

  // Past 50: said once, however often the band refreshes above it.
  quota.percent = 51
  await refresh()
  expect(toasts).toEqual(['Session quota: 50% reached (resets in 5h00)'])
  quota.percent = 52
  await refresh()
  await refresh(30000)
  expect(toasts.length).toBe(1)

  // Past 80: the next threshold, once too.
  quota.percent = 81
  await refresh(30000)
  await refresh()
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toBe('Session quota: 80% reached (resets in 4h59)')
})

test('does not toast again in a session that shares the store', async ($, on) => {
  // Another session of the machine already said 80% for this cycle; its
  // reset instant differs from this one's by a second.
  mock.store(on, { alerts: { five_hour: { resetsAt: Date.parse('1970-01-01T05:00:01Z'), level: 80 } } })
  const quota: Quota = { percent: 85, resetsAt: '1970-01-01T05:00:00Z' }
  const { toasts, refresh } = WATCH($, on, quota)

  await refresh()
  await refresh(30000)
  expect(toasts).toEqual([])

  // The next threshold is this session's to say.
  quota.percent = 91
  await refresh()
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/^Session quota: 90% reached \(resets in /)
})

test('toasts again after the window resets', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 95, resetsAt: '1970-01-01T05:00:00Z' }
  const { toasts, refresh } = WATCH($, on, quota)

  // Seen first already past every threshold: the highest alone is said.
  await refresh()
  expect(toasts).toEqual(['Session quota: 90% reached (resets in 5h00)'])

  // The same cycle under an instant a few seconds off: nothing more.
  quota.resetsAt = '1970-01-01T05:00:03Z'
  await refresh(30000)
  expect(toasts.length).toBe(1)

  // A new cycle starts low, then climbs past 50 again.
  quota.resetsAt = '1970-01-01T10:00:00Z'
  quota.percent = 3
  await refresh(30000)
  expect(toasts.length).toBe(1)
  quota.percent = 55
  await refresh(30000)
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toMatch(/^Session quota: 50% reached/)
})

test('a failed toast leaves the figures refreshed', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 95, resetsAt: '1970-01-01T05:00:00Z', refusesToasts: true }
  const { toasts, refresh, texts } = WATCH($, on, quota)

  await refresh()
  expect(await texts()).toContain('95%')

  // And the next refresh draws the new figure, without saying the alert again.
  quota.percent = 96
  quota.refusesToasts = false
  await refresh(30000)
  expect(await texts()).toContain('96%')
  expect(toasts).toEqual([])
})

const MINUTE = 60000
const projections = (texts: readonly unknown[]) =>
  texts.filter(t => typeof t === 'string' && t.includes('full in'))

test('projects when the session quota runs out, only before its reset', async ($, on) => {
  mock.store(on)
  // The session window resets half an hour from the start.
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T00:30:00Z' }
  const { refresh, texts } = WATCH($, on, quota)

  await refresh()
  expect(projections(await texts())).toEqual([])

  // 2 points a minute: full 35 minutes on, after the reset. Nothing to say.
  quota.percent = 30
  await refresh(5 * MINUTE)
  expect(projections(await texts())).toEqual([])

  // 4 points a minute over the ten minutes: full in 10, before the reset.
  quota.percent = 60
  await refresh(5 * MINUTE)
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const projection = await ui.find({ type: 'Text', text: /full in/ })
  await ui.unmount()
  expect(projection?.text).toBe(' full in 10m')
  expect(projection?.props.color).toBe('#ff8c00')
  // After the session's reset delay, before the week's gauge.
  expect(shown[shown.indexOf(' full in 10m') - 1]).toBe(' ↻ 20m')
})

test('projects nothing on a flat or too short history', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)

  // Long enough, but under one point of rise.
  await refresh()
  quota.percent = 20.4
  await refresh(6 * MINUTE)
  expect(projections(await texts())).toEqual([])

  // Those samples leave the 15 minutes; a steep rise over 2 minutes is too
  // short to say anything.
  await refresh(24 * MINUTE)
  quota.percent = 60
  await refresh(2 * MINUTE)
  expect(projections(await texts())).toEqual([])

  // Past 5 minutes the same history speaks.
  quota.percent = 70
  await refresh(4 * MINUTE)
  expect(projections(await texts()).length).toBe(1)
})

test('keeps the projection off the band under projectionMinPercent', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)

  // Full in 35 minutes, long before the reset, but at 30% of the window.
  await refresh()
  quota.percent = 30
  await refresh(5 * MINUTE)
  expect(projections(await texts())).toEqual([])

  // At the 50% of the setting the same pace is said.
  quota.percent = 50
  await refresh(5 * MINUTE)
  expect(projections(await texts())).toEqual([' full in 17m'])
})

test('starts the history over after a reset', { options: { projectionMinPercent: 0 } }, async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)

  await refresh()
  quota.percent = 30
  await refresh(5 * MINUTE)
  expect(projections(await texts())).toEqual([' full in 35m'])

  // A new cycle: the figure fell, and nothing of the old history is used.
  quota.resetsAt = '1970-01-01T10:00:00Z'
  quota.percent = 5
  await refresh(MINUTE)
  expect(projections(await texts())).toEqual([])

  // Five minutes into it, under a reset instant two seconds off: its own
  // pace alone, 4 points a minute from 25%.
  quota.resetsAt = '1970-01-01T10:00:02Z'
  quota.percent = 25
  await refresh(5 * MINUTE)
  expect(projections(await texts())).toEqual([' full in 19m'])
})

const SLASH = async ($: Parameters<TestBody>[0], args: string) =>
  (await $.command.run({ command: 'usage-bar', args } as never)).text

test('hides and shows the band on /usage-bar', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)
  const specs: unknown[] = []
  on('command.register', (_, e) => {
    specs.push(e)

    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  // What the surface draws there without the band: an empty box.
  on('ui.render', () => ({ type: 'Box' }) as never)

  // The session start declares the command, to run mid-turn too.
  await $.session.start({ source: 'startup', cwd: '/home/me/Projects' } as never)
  await refresh()
  expect(specs.length).toBe(1)
  expect(specs[0]).toMatchObject({ name: 'usage-bar', argumentHint: '[hide|show|full|compact|refresh|status|config]', immediate: true })
  expect(await texts()).toContain('20%')

  // Hidden: nothing of the band is drawn, and saying it twice changes nothing.
  expect(await SLASH($, 'hide')).toMatch(/^usage-bar: band hidden/)
  expect(await texts()).not.toContain('20%')
  expect(await SLASH($, ' HIDE ')).toMatch(/^usage-bar: band hidden/)
  expect(await texts()).not.toContain('20%')

  // The figures go on being refreshed meanwhile: shown again, they are current.
  quota.percent = 30
  await refresh(30000)
  expect(await SLASH($, 'show')).toBe('usage-bar: band shown')
  expect(await texts()).toContain('30%')

  // Without an argument the command toggles.
  expect(await SLASH($, '')).toMatch(/^usage-bar: band hidden/)
  expect(await texts()).not.toContain('30%')
  expect(await SLASH($, '')).toBe('usage-bar: band shown')
  expect(await texts()).toContain('30%')
})

test('refreshes at once on /usage-bar refresh', async ($, on) => {
  let requests = 0
  let reads = 0
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => {
    reads += 1

    return { value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => {
    requests += 1

    return { value: { status: 200, ok: true, headers: {}, text: USAGE } }
  })
  const measure = async () => {
    await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['rateLimits'] })
    await clock.advance(0)
  }

  // Within the 30 seconds a refresh asks the endpoint nothing.
  await measure()
  await measure()
  expect(requests).toBe(1)

  // The command asks it now, once: the generic command hook stays out of it.
  const readsBefore = reads
  expect(await SLASH($, 'refresh')).toBe('usage-bar: refresh requested')
  await clock.advance(0)
  expect(requests).toBe(2)
  expect(reads).toBe(readsBefore + 1)

  // And the wait starts over from there.
  await measure()
  expect(requests).toBe(2)
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  expect(await ui.find({ type: 'Text', text: /^95%$/ })).toBeDefined()
  await ui.unmount()
})

test('answers an unknown argument with its usage line', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)

  await refresh()
  const answer = await SLASH($, 'whatever')
  expect(answer).toMatch(/^Usage: \/usage-bar \[hide\|show\|full\|compact\|refresh\|status\|config\]/)
  expect(answer).not.toContain('\n')
  // And nothing changed: the band is still drawn.
  expect(await texts()).toContain('20%')
})

test('survives a refused registration', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)
  let attempts = 0
  on('command.register', () => {
    attempts += 1

    throw new Error('refused')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)

  await $.session.start({ source: 'startup', cwd: '/home/me/Projects' } as never)
  await refresh()
  expect(attempts).toBe(1)
  // The band is drawn and goes on refreshing.
  expect(await texts()).toContain('20%')
  quota.percent = 30
  await refresh(30000)
  expect(await texts()).toContain('30%')
})

const activities = (texts: readonly unknown[]) =>
  texts.filter(t => typeof t === 'string' && t.startsWith('▶'))

test('shows a running subagent and how long it has run', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)
  let agents = [
    { id: 'agent-run-1', description: 'looks around', type: 'Explore', status: 'running' },
    { id: 'agent-run-2', description: 'done already', type: 'Plan', status: 'completed' },
  ]
  on('agent.list', () => ({ value: agents }) as never)
  // A working tree, to place the activity after it.
  on('process.run', (_, e) =>
    e.argv.includes('diff') ? RUN(' 2 files changed, 9 insertions(+), 1 deletion(-)\n') : RUN('', 1),
  )

  // Counted from the moment the band first sees it; a finished one is left out.
  await refresh()
  expect(activities(await texts())).toEqual(['▶ Explore 0m'])

  await refresh(2 * MINUTE)
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  const shown = await ui.find({ type: 'Text', text: /^▶ Explore 2m$/ })
  const figures = JSON.stringify(await ui.find({ key: 'figures' }))
  await ui.unmount()
  expect(shown).toBeDefined()
  expect(shown?.props.color).toBe('#8a8f98')
  // At the end of the second line, after the working tree.
  expect(figures.indexOf('2 files')).toBeGreaterThan(-1)
  expect(figures.indexOf('2 files')).toBeLessThan(figures.indexOf('▶ Explore 2m'))

  // A second one starts its own count beside the first.
  agents = [...agents, { id: 'agent-run-3', description: 'reviews', type: 'reviewer-high', status: 'running' }]
  await refresh(MINUTE)
  expect(activities(await texts())).toEqual(['▶ Explore 3m', '▶ reviewer-high 0m'])

  // Once none runs any more, nothing is said.
  agents = agents.map(a => ({ ...a, status: 'completed' }))
  await refresh(MINUTE)
  expect(activities(await texts())).toEqual([])
})

test('shows nothing when no agent list is usable', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)
  let list: () => unknown = () => {
    throw new Error('no agents here')
  }
  on('agent.list', () => ({ value: list() }) as never)
  on('process.run', () => RUN(' 2 files changed, 9 insertions(+), 1 deletion(-)\n'))
  // The band is drawn all the same, without any activity.
  const expectNone = async () => {
    await refresh(30000)
    const shown = await texts()
    expect(shown).toContain('20%')
    expect(activities(shown)).toEqual([])
  }

  // A list that fails.
  await expectNone()

  // A list that is no list, or whose rows are not agents.
  list = () => ({ agents: [] })
  await expectNone()
  list = () => [null, { id: 7, type: 'Explore', status: 'running' }, { id: 'x', status: 'running' }]
  await expectNone()

  // An empty list.
  list = () => []
  await expectNone()
})

// A band with resets, a working tree and a branch ahead of its upstream:
// 65 cells across on its second line, 47 on its first.
const WIDE_BAND = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  const clock = mock.clock(on)
  mock.store(on)
  const rateLimits = [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '1970-01-01T03:30:00Z' }]
  let commandRuns = 0
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: { effortLevel: 'high' } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: USAGE } }))
  on('process.run', (_, e) => {
    commandRuns += 1

    return e.argv.includes('status')
      ? RUN('# branch.head feature/bar\n# branch.ab +2 -0\n')
      : e.argv.includes('diff')
        ? RUN(' 2 files changed, 9 insertions(+), 1 deletion(-)\n')
        : RUN('', 1)
  })

  await $.session.measure({ context: { window: 200000, percent: 42 }, rateLimits, changed: ['rateLimits'] })
  await clock.advance(0)

  // What the band draws in `bodyColumns` cells; none given when undefined.
  return async (bodyColumns?: number) => {
    const before = commandRuns
    const ui = await $.ui.mount({
      ...BAND,
      props: { hasSurvey: false, isWorking: false, ...(bodyColumns === undefined ? {} : { bodyColumns }) } as never,
    })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const buttons = (await ui.findAll({ type: 'Button' })).length
    await ui.unmount()
    // Drawing asks the machine nothing, whatever the width.
    expect(commandRuns).toBe(before)

    return { texts, buttons }
  }
}

test('measures a text in terminal cells', async () => {
  expect(cellWidth('')).toBe(0)
  expect(cellWidth('24% | 3 files')).toBe(13)
  // An emoji takes two cells; arrows, the gear and the sum sign take one.
  expect(cellWidth('⌛ ')).toBe(3)
  expect(cellWidth('📅🧠💰💸')).toBe(8)
  expect(cellWidth(' ↻ 6d22h')).toBe(8)
  expect(cellWidth('⚙ ↑2 Σ ×')).toBe(8)
  expect(cellWidth('日本')).toBe(4)
})

test('drops the reset delays, then the working tree, as the band narrows', async ($, on) => {
  const drawn = await WIDE_BAND($, on)
  const figures = ['24%', '2%', '95%', '42%']

  // Room for everything.
  let shown = await drawn(200)
  expect(shown.texts).toEqual(expect.arrayContaining([...figures, ' ↻ 3h30', ' ↻ 6d22h', '2 files', ' +9', ' -1']))
  expect(shown.texts).toEqual(expect.arrayContaining(['feature/bar', ' ↑2', ' (high)']))
  expect(shown.buttons).toBe(2)

  // 60 cells: the resets leave, the working tree and every figure stay.
  shown = await drawn(60)
  expect(shown.texts.some(t => typeof t === 'string' && t.includes('↻'))).toBe(false)
  expect(shown.texts).toEqual(expect.arrayContaining([...figures, '2 files', ' +9', ' -1']))
  expect(shown.texts).toEqual(expect.arrayContaining(['feature/bar', ' ↑2']))

  // 40 cells: the working tree leaves too; the head line loses the unpushed
  // commits, then the branch. Figures, model and both buttons stay.
  shown = await drawn(40)
  expect(shown.texts.some(t => typeof t === 'string' && (t.includes('↻') || t.includes('file')))).toBe(false)
  expect(shown.texts).toEqual(expect.arrayContaining([...figures, 'Projects', 'Opus-5.5', ' (high)']))
  expect(shown.texts).not.toContain('feature/bar')
  expect(shown.texts).not.toContain(' ↑2')
  expect(shown.buttons).toBe(2)

  // Narrower than the narrowest line: that one is drawn all the same.
  shown = await drawn(5)
  expect(shown.texts).toEqual(expect.arrayContaining([...figures, 'Opus-5.5']))
})

test('draws everything when the surface gives no width', async ($, on) => {
  const drawn = await WIDE_BAND($, on)
  const shown = await drawn()

  expect(shown.texts).toEqual(
    expect.arrayContaining(['24%', ' ↻ 3h30', '2%', ' ↻ 6d22h', '95%', '42%', '2 files', ' +9', ' -1']),
  )
  expect(shown.texts).toEqual(expect.arrayContaining(['Projects', 'feature/bar', ' ↑2', 'Opus-5.5', ' (high)']))
})

// A drawn band whose test hook on `command.run` notes what was asked, or
// refuses it.
// `listed`: the commands the session lists, none when absent and a failing
// list when null. `costUsd`: the session's ledger.
type Pressable = { listed?: readonly string[] | null; costUsd?: number }

const PRESSABLE = async (
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  isRefused = false,
  { listed, costUsd }: Pressable = {},
) => {
  const clock = mock.clock(on)
  mock.store(on)
  const opened: string[] = []
  const asked: { command: string; args?: string }[] = []
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, percent: 42 },
      rateLimits: [],
      ...(costUsd === undefined ? {} : { cost: { usd: costUsd } }),
    },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: null }))

  if (listed !== undefined) {
    on('command.list', () => {
      if (listed === null) {
        throw new Error('no list here')
      }

      return { value: listed.map(name => ({ name, description: '', source: 'builtin' })) } as never
    })
  }

  on('command.run', (_, e) => {
    if (isRefused) {
      throw new Error('refused')
    }

    opened.push(e.command)
    asked.push({ command: e.command, ...(e.args ? { args: e.args } : {}) })

    return { text: '' }
  })

  await $.session.measure({ context: { window: 200000, percent: 42 }, rateLimits: [], changed: ['context'] })
  await clock.advance(0)

  return { clock, opened, asked }
}

test('opens /model when the gear is pressed', async ($, on) => {
  const { clock, opened } = await PRESSABLE($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    opened.length = 0
    const ui = await $.ui.mount({ ...BAND, surface, props: { hasSurvey: false, isWorking: false } as never })
    // The name stays a text; the gear after it is the button, with no hotkey.
    expect(await ui.find({ type: 'Text', text: /^Opus-5\.5$/ })).toBeDefined()
    const gear = await ui.find({ type: 'Button', key: 'model' })
    expect(gear).toBeDefined()
    expect(gear?.props.plain).toBe(true)
    expect(gear?.props.hotkey).toBeUndefined()
    expect(JSON.stringify(await ui.find({ key: 'head' }))).toContain('⚙')

    await ui.press({ key: 'model' })
    await clock.advance(0)
    expect(opened).toEqual(['model'])
    await ui.unmount()
  }
})

test('opens /context when the context icon is pressed', async ($, on) => {
  const { clock, opened } = await PRESSABLE($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    opened.length = 0
    const ui = await $.ui.mount({ ...BAND, surface, props: { hasSurvey: false, isWorking: false } as never })
    const icon = await ui.find({ type: 'Button', key: 'context' })
    expect(icon).toBeDefined()
    expect(icon?.props.hotkey).toBeUndefined()
    expect(JSON.stringify(await ui.find({ key: 'figures' }))).toContain('🧠')
    // The percentage beside it stays a colored text.
    expect((await ui.find({ type: 'Text', text: /^42%$/ }))?.props.color).toBe('green')

    await ui.press({ key: 'context' })
    await clock.advance(0)
    expect(opened).toEqual(['context'])
    await ui.unmount()
  }
})

test('a refused command leaves the band drawn', async ($, on) => {
  const { clock, opened } = await PRESSABLE($, on, true)
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })

  await ui.press({ key: 'model' })
  await ui.press({ key: 'context' })
  await clock.advance(0)
  expect(opened).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'model' })).toBeDefined()
  await ui.unmount()

  // And a fresh drawing is whole.
  const again = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  expect(await again.find({ type: 'Text', text: /^Opus-5\.5$/ })).toBeDefined()
  expect(await again.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
  await again.unmount()
})

test('hides the projection when showProjection is off',{ options: { showProjection: false } }, async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)

  await refresh()
  quota.percent = 60
  await refresh(5 * MINUTE)
  const shown = await texts()
  expect(shown).toContain('60%')
  expect(projections(shown)).toEqual([])
})

test('does not hammer an endpoint that just refused on /usage-bar refresh', async ($, on) => {
  let requests = 0
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => {
    requests += 1

    return { value: { status: 429, ok: false, headers: {}, text: '' } }
  })

  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['rateLimits'] })
  await clock.advance(0)
  expect(requests).toBe(1)

  // The server just refused: the command says so and asks it nothing.
  expect(await SLASH($, 'refresh')).toBe(
    'usage-bar: refresh requested; the server refused the last request, next try in 120 s',
  )
  await clock.advance(0)
  expect(requests).toBe(1)

  // Nor a second before the 120 seconds are over.
  await clock.advance(119000)
  expect(await SLASH($, 'refresh')).toMatch(/next try in 1 s$/)
  await clock.advance(0)
  expect(requests).toBe(1)

  // Once they are, a request goes out.
  await clock.advance(1000)
  expect(await SLASH($, 'refresh')).toBe('usage-bar: refresh requested')
  await clock.advance(0)
  expect(requests).toBe(2)
})

// A Claude session whose endpoint reports Fable at 95%, with a context and a
// running subagent: what the band asked, said and draws.
const FULL_BAND = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  const clock = mock.clock(on)
  mock.store(on)
  const toasts: string[] = []
  const asked = { agents: 0 }
  const rateLimits = [{ kind: 'five_hour', percentUsed: 20, resetsAt: '1970-01-01T05:00:00Z' }]
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: USAGE } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('agent.list', () => {
    asked.agents += 1

    return { value: [{ id: 'agent-run-1', description: 'looks around', type: 'Explore', status: 'running' }] }
  })
  on('process.run', () => RUN('', 128))

  await $.session.measure({ context: { window: 200000, percent: 42 }, rateLimits, changed: ['rateLimits'] })
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const buttons = (await ui.findAll({ type: 'Button' })).length
  await ui.unmount()

  return { toasts, asked, texts, buttons }
}

test('does not toast for a window the band hides', { options: { showFable: false } }, async ($, on) => {
  const { toasts, texts } = await FULL_BAND($, on)

  // The endpoint was read, the week it reports is drawn, and Fable at 95% is
  // neither drawn nor said.
  expect(texts).toContain('2%')
  expect(texts).not.toContain('95%')
  expect(toasts).toEqual([])
})

test(
  'hides Fable, the context and the activity when their settings are off',
  { options: { showFable: false, showContext: false, showActivity: false } },
  async ($, on) => {
    const { asked, texts, buttons } = await FULL_BAND($, on)

    expect(texts).toContain('20%')
    expect(texts).not.toContain('95%')
    expect(texts).not.toContain('42%')
    expect(activities(texts)).toEqual([])
    // The gear of the model alone: no context icon to press.
    expect(buttons).toBe(1)
    // And the list is not asked.
    expect(asked).toEqual({ agents: 0 })
  },
)

test(
  'reads its settings from the plugin options',
  { options: { showGit: false, warnPercent: 10, dangerPercent: 20 } },
  async ($, on) => {
    let gitRuns = 0
    const clock = mock.clock(on)
    mock.store(on)
    on('session.cwd', () => ({ value: '/home/me/Projects' }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.id', () => ({ value: 'session-1' }))
    on('settings.read', () => ({ value: {} }))
    on('session.usage', () => ({
      value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [] },
    }))
    on('session.measure', (_, e) => ({ changed: e.changed }))
    on('session.authorize', () => ({ value: null }))
    on('process.run', (_, e) => {
      // The working tree's commands; the branch of the head line is asked
      // whatever showGit says.
      if (e.argv.includes('diff') || e.argv.includes('ls-files')) {
        gitRuns += 1
      }

      return {
        value: {
          exitCode: 0,
          stdout: ' 2 files changed, 9 insertions(+), 1 deletion(-)\n',
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    })

    await $.session.measure({ context: { window: 200000, percent: 42 }, rateLimits: [], changed: ['context'] })
    await clock.advance(0)

    const ui = await $.ui.mount({
      plugin: 'usage-bar',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false } as never,
    })
    // showGit off: no segment, and git is not even asked.
    expect(await ui.find({ type: 'Text', text: /files?$/ })).toBeUndefined()
    expect(gitRuns).toBe(0)
    // 42% is past a danger threshold of 20: red, where the default is green.
    const context = await ui.findAll({ type: 'Text', text: /^42%$/ })
    expect(context.length).toBe(1)
    expect(context.every(c => c.props.color === 'red')).toBe(true)
    await ui.unmount()
  },
)

test(
  'falls back to the defaults on invalid settings',
  // Values of the right type that do not fit; the host itself refuses to load
  // the module on a value of the wrong type.
  { options: { warnPercent: 150, dangerPercent: -1, quotaAlerts: 'abc' } },
  async ($, on) => {
    mock.store(on)
    const quota: Quota = { percent: 51, resetsAt: '1970-01-01T05:00:00Z' }
    const { toasts, refresh } = WATCH($, on, quota)
    const colorOf = async (text: RegExp) => {
      const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
      const found = await ui.find({ type: 'Text', text })
      await ui.unmount()

      return found?.props.color
    }

    // Thresholds outside 0-100: the defaults 50 and 90 apply, so 51% is a
    // warning (green at 150, red at -1). Alerts that are no numbers: the
    // default 50, 80 and 90 apply.
    await refresh()
    expect(await colorOf(/^51%$/)).toBe('#ff8c00')
    expect(toasts).toEqual(['Session quota: 50% reached (resets in 5h00)'])

    // And danger from the default 90.
    quota.percent = 95
    await refresh()
    expect(await colorOf(/^95%$/)).toBe('red')
    expect(toasts.length).toBe(2)
    expect(toasts[1]).toBe('Session quota: 90% reached (resets in 5h00)')
  },
)

test('raises no quota alert when quotaAlerts is empty', { options: { quotaAlerts: '' } }, async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 95, resetsAt: '1970-01-01T05:00:00Z' }
  const { toasts, refresh, texts } = WATCH($, on, quota)

  await refresh()
  expect(await texts()).toContain('95%')
  expect(toasts).toEqual([])
})

test('refreshes the activity when a subagent is spawned', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts, clock } = WATCH($, on, quota)
  let agents: unknown[] = []
  on('agent.list', () => ({ value: agents }) as never)
  on('agent.spawn', () => ({ model: 'sonnet' }) as never)

  await refresh()
  expect(activities(await texts())).toEqual([])

  // The spawn alone, with no measure and no tick, names the subagent.
  agents = [{ id: 'agent-run-1', description: 'looks around', type: 'Explore', status: 'running' }]
  await $.agent.spawn({ prompt: 'Look around.', description: 'looks around', subagentType: 'Explore' } as never)
  await clock.advance(0)
  expect(activities(await texts())).toEqual(['▶ Explore 0m'])
})

const PANE = { plugin: 'usage-bar', component: 'Pane', requestId: 'usage-bar-config' } as const
const PANE_PROPS = { title: 'usage-bar', isFocused: true, bodyColumns: 80, placement: 'inline' } as never
type Answer = { isPlaced?: false; deny?: string; rejects?: boolean }

// A session whose test hooks stand for the surface and the settings writer:
// the panes opened, the changes asked, the toasts raised, and how the next
// open or change is answered.
const SETTINGS = (on: Parameters<TestBody>[1], answer: Answer = {}) => {
  mock.store(on)
  const opens: unknown[] = []
  const closes: unknown[] = []
  const sets: { key: string; value: unknown }[] = []
  const toasts: string[] = []
  on('ui.open', (_, e) => {
    opens.push(e)

    return { value: answer.isPlaced === false ? { isPlaced: false, reason: 'too narrow' } : { isPlaced: true } } as never
  })
  on('ui.close', (_, e) => {
    closes.push(e)

    return { value: undefined }
  })
  on('config.set', (_, e) => {
    sets.push({ key: e.key, value: e.value })

    if (answer.rejects) {
      throw new Error('no such row')
    }

    return answer.deny === undefined ? { value: e.value } : { deny: answer.deny }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { opens, closes, sets, toasts }
}

test('opens the settings pane on /usage-bar config', async ($, on) => {
  const { opens, closes } = SETTINGS(on)

  expect(await SLASH($, ' Config ')).toBe('usage-bar: settings opened')
  expect(opens).toHaveLength(1)
  expect(opens[0]).toMatchObject({
    id: 'usage-bar-config',
    title: 'usage-bar',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: PANE_PROPS })
    const titles = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    // The three groups, and a sample beside each color.
    expect(titles).toEqual([
      'Thresholds and colors',
      ' ███',
      ' ███',
      ' ███',
      ' sample ',
      'Alerts',
      'Segments',
    ])
    // The nineteen fields, with the values the module was loaded with.
    expect(await ui.findAll({ type: 'Input' })).toHaveLength(10)
    expect(await ui.findAll({ type: 'Select' })).toHaveLength(9)
    expect((await ui.find({ type: 'Select', key: 'layout' }))?.props.label).toBe('Layout')
    expect((await ui.find({ type: 'Input', key: 'warnPercent' }))?.props.value).toBe('50')
    expect((await ui.find({ type: 'Input', key: 'quotaAlerts' }))?.props.value).toBe('50,80,90')
    expect((await ui.find({ type: 'Select', key: 'showGit' }))?.props.value).toBe('on')
    expect((await ui.find({ type: 'Select', key: 'resetStyle' }))?.props.value).toBe('delay')
    // The pane speaks English, as the band does.
    expect((await ui.find({ type: 'Input', key: 'warnPercent' }))?.props.label).toBe('Warning threshold')
    expect((await ui.find({ type: 'Select', key: 'showGit' }))?.props.label).toBe('Show working tree')
    expect((await ui.find({ type: 'Button', key: 'close' }))?.props.label).toBe('Close')

    closes.length = 0
    await ui.press({ key: 'close' })
    expect(closes).toMatchObject([{ id: 'usage-bar-config' }])
    await ui.unmount()
  }
})

test('changes a setting from the pane through config.set', async ($, on) => {
  const { sets, toasts } = SETTINGS(on)
  await SLASH($, 'config')

  for (const surface of ['terminal', 'desktop'] as const) {
    sets.length = 0
    const ui = await $.ui.mount({ ...PANE, surface, props: PANE_PROPS })

    // A flag and a choice are picked; a number and a text are typed and sent.
    await ui.select({ key: 'showGit', value: surface === 'terminal' ? 'off' : 'on' })
    await ui.select({ key: 'resetStyle', value: 'time' })
    await ui.input({ key: 'dangerPercent', text: ' 85 ' })
    await ui.input({ key: 'colorWarn', text: '#ffaa00' })
    await ui.input({ key: 'quotaAlerts', text: '' })
    await ui.input({ key: 'colorOk', text: '#fa0' })
    await ui.input({ key: 'colorDanger', text: 'rgb(255, 140, 0)' })
    expect(sets).toEqual([
      { key: 'usage-bar.showGit', value: surface === 'terminal' ? false : true },
      { key: 'usage-bar.resetStyle', value: 'time' },
      { key: 'usage-bar.dangerPercent', value: 85 },
      { key: 'usage-bar.colorWarn', value: '#ffaa00' },
      { key: 'usage-bar.quotaAlerts', value: '' },
      { key: 'usage-bar.colorOk', value: '#fa0' },
      { key: 'usage-bar.colorDanger', value: 'rgb(255, 140, 0)' },
    ])
    expect(toasts).toEqual([])
    await ui.unmount()

    // The pane shows what was written, with no reload of the module.
    const again = await $.ui.mount({ ...PANE, surface, props: PANE_PROPS })
    expect((await again.find({ type: 'Select', key: 'showGit' }))?.props.value).toBe(
      surface === 'terminal' ? 'off' : 'on',
    )
    expect((await again.find({ type: 'Select', key: 'resetStyle' }))?.props.value).toBe('time')
    expect((await again.find({ type: 'Input', key: 'dangerPercent' }))?.props.value).toBe('85')
    expect((await again.find({ type: 'Input', key: 'colorWarn' }))?.props.value).toBe('#ffaa00')
    expect((await again.find({ type: 'Input', key: 'quotaAlerts' }))?.props.value).toBe('')
    await again.unmount()
  }
})

test('keeps the pane drawn when a change is refused', async ($, on) => {
  const answer: Answer = { deny: 'locked by policy' }
  const { sets, toasts } = SETTINGS(on, answer)
  await SLASH($, 'config')

  for (const surface of ['terminal', 'desktop'] as const) {
    sets.length = 0
    toasts.length = 0
    const ui = await $.ui.mount({ ...PANE, surface, props: PANE_PROPS })

    // A `{ deny }`, then a rejection: each is said, and the value stays.
    answer.rejects = false
    await ui.select({ key: 'showGit', value: 'off' })
    answer.rejects = true
    await ui.input({ key: 'warnPercent', text: '40' })
    expect(sets).toHaveLength(2)
    // A value that does not fit never reaches the writer.
    for (const text of ['many', '0x1A', '1e1', '101', '']) {
      await ui.input({ key: 'warnPercent', text })
    }
    for (const text of ['50,-1', '0x1A', '1e1,50']) {
      await ui.input({ key: 'quotaAlerts', text })
    }
    for (const text of ['rgb(256,0,0)', 'ansi256(256)']) {
      await ui.input({ key: 'colorWarn', text })
    }
    await ui.input({ key: 'colorOk', text: 'not a color' })
    expect(sets).toHaveLength(2)
    // Said in the pane alone: a toast would wait behind it.
    expect(toasts).toEqual([])
    await ui.unmount()

    const again = await $.ui.mount({ ...PANE, surface, props: PANE_PROPS })
    expect((await again.find({ type: 'Select', key: 'showGit' }))?.props.value).toBe('on')
    expect((await again.find({ type: 'Input', key: 'warnPercent' }))?.props.value).toBe('50')
    expect((await again.find({ type: 'Input', key: 'colorOk' }))?.props.value).toBe('green')
    // The last refusal is said in the pane.
    expect(await again.find({ type: 'Text', text: /^Color: ok: expects a color name/ })).toBeDefined()
    expect(await again.find({ type: 'Button', key: 'close' })).toBeDefined()
    await again.unmount()
  }
})

test('hides its rows from /config', async ($, on) => {
  on('config.describe', (_, e) => ({ label: e.label, description: e.description, isHidden: e.isHidden }) as never)
  const describe = async (key: string) =>
    $.config.describe({ key, label: key, isHidden: false, provider: { kind: 'plugin', name: 'usage-bar' } } as never)

  for (const field of ['warnPercent', 'showGit', 'resetStyle', 'layout']) {
    expect(await describe(`usage-bar.${field}`)).toMatchObject({ isHidden: true, label: `usage-bar.${field}` })
  }

  // Any other row is left as it was.
  expect(await describe('theme')).toMatchObject({ isHidden: false })
  expect(await describe('usage-bars.showGit')).toMatchObject({ isHidden: false })
})

test('says so when the pane cannot be placed', async ($, on) => {
  const { opens } = SETTINGS(on, { isPlaced: false })

  expect(await SLASH($, 'config')).toBe(
    'usage-bar: settings pane opened but not shown here (too narrow)',
  )
  expect(opens).toHaveLength(1)
})

test('fills an open pane again when the module is reloaded', { options: { warnPercent: 70 } }, async ($, on) => {
  SETTINGS(on)
  const clock = mock.clock(on)
  let panes: unknown = [{ id: 'usage-bar-config', title: 'usage-bar' }]
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('ui.panes', () => {
    if (panes === undefined) {
      throw new Error('no pane list')
    }

    return { value: panes } as never
  })
  const warn = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    const value = (await ui.find({ type: 'Input', key: 'warnPercent' }))?.props.value
    await ui.unmount()

    return value
  }

  // No pane up, or no list: nothing is filled, and nothing throws.
  for (const answer of [[], undefined]) {
    panes = answer
    await $.session.start({ source: 'startup', cwd: '/home/me/Projects' } as never)
    await clock.advance(0)
    expect(await warn()).toBeUndefined()
  }

  // The pane stayed up through a reload: it shows the options of the new module.
  panes = [{ id: 'usage-bar-config', title: 'usage-bar' }]
  await $.session.start({ source: 'startup', cwd: '/home/me/Projects' } as never)
  await clock.advance(0)
  expect(await warn()).toBe('70')
})

test('keeps the notice of an open pane through a reload', async ($, on) => {
  SETTINGS(on)
  const clock = mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('ui.panes', () => ({ value: [{ id: 'usage-bar-config', title: 'usage-bar' }] }) as never)
  const notice = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    const found = await ui.find({ type: 'Text', text: /^Warning threshold: must stay under/ })
    await ui.unmount()

    return found
  }

  await SLASH($, 'config')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  await ui.input({ key: 'warnPercent', text: '90' })
  await ui.unmount()
  expect(await notice()).toBeDefined()

  // The reload fills the values again, and leaves the notice.
  await $.session.start({ source: 'startup', cwd: '/home/me/Projects' } as never)
  await clock.advance(0)
  expect(await notice()).toBeDefined()

  // Opened anew, the pane says nothing.
  await SLASH($, 'config')
  expect(await notice()).toBeUndefined()
})

test('shows in the pane a setting changed outside it', async ($, on) => {
  const answer: Answer = {}
  SETTINGS(on, answer)
  const warn = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    const value = (await ui.find({ type: 'Input', key: 'warnPercent' }))?.props.value
    await ui.unmount()

    return value
  }

  // Before the pane was ever opened, a change fills nothing.
  await $.config.set({ key: 'usage-bar.warnPercent', value: 60 } as never)
  expect(await warn()).toBeUndefined()

  await SLASH($, 'config')
  await $.config.set({ key: 'usage-bar.warnPercent', value: 65 } as never)
  expect(await warn()).toBe('65')

  // Another row, or a refused change, leaves the pane as it was.
  await $.config.set({ key: 'theme', value: 'dark' } as never)
  answer.deny = 'locked by policy'
  await $.config.set({ key: 'usage-bar.warnPercent', value: 80 } as never)
  expect(await warn()).toBe('65')
})

test('keeps the projection on a band too narrow for the resets', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T00:30:00Z' }
  const { refresh } = WATCH($, on, quota)

  // 4 points a minute: full in 10 minutes, before the reset in 20.
  await refresh()
  quota.percent = 60
  await refresh(10 * MINUTE)
  const drawn = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false, bodyColumns } as never })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()

    return {
      hasReset: texts.some(t => typeof t === 'string' && t.includes('↻')),
      hasProjection: projections(texts).length > 0,
      hasFigure: texts.includes('60%'),
    }
  }

  expect(await drawn(200)).toEqual({ hasReset: true, hasProjection: true, hasFigure: true })

  // Narrowing, the reset leaves first: some widths show the projection alone.
  const widths: number[] = []

  for (let columns = 199; columns > 5; columns -= 1) {
    const shown = await drawn(columns)

    // The projection never leaves before the reset.
    expect(shown.hasReset && !shown.hasProjection).toBe(false)

    if (!shown.hasReset && shown.hasProjection) {
      widths.push(columns)
    }
  }

  expect(widths.length).toBeGreaterThan(0)
  // At the narrowest the figure alone stays.
  expect(await drawn(5)).toEqual({ hasReset: false, hasProjection: false, hasFigure: true })
})

test('says a reset past a day in days and hours', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-03T00:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)

  // A whole number of days: no hours.
  await refresh()
  expect(await texts()).toContain(' ↻ 2d')

  // 53 hours.
  quota.resetsAt = '1970-01-03T05:00:00Z'
  await refresh()
  expect(await texts()).toContain(' ↻ 2d5h')

  // Under a day: hours and minutes, as before.
  quota.resetsAt = '1970-01-01T23:30:00Z'
  await refresh()
  expect(await texts()).toContain(' ↻ 23h30')
})

test('refuses a warning threshold that is not under the danger one', async ($, on) => {
  const { sets, toasts } = SETTINGS(on)
  await SLASH($, 'config')
  const pane = async () => $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  const notice = async (text: RegExp) => {
    const ui = await pane()
    const found = await ui.find({ type: 'Text', text })
    const values = [
      (await ui.find({ type: 'Input', key: 'warnPercent' }))?.props.value,
      (await ui.find({ type: 'Input', key: 'dangerPercent' }))?.props.value,
    ]
    await ui.unmount()

    return { found, values }
  }

  // A warning at or past the danger of 90: said in the pane, nothing written.
  let ui = await pane()
  await ui.input({ key: 'warnPercent', text: '90' })
  await ui.unmount()
  expect(sets).toEqual([])
  let shown = await notice(/^Warning threshold: must stay under the danger threshold \(90\)$/)
  expect(shown.found).toBeDefined()
  expect(shown.values).toEqual(['50', '90'])

  // A danger at or under the warning of 50: the same.
  ui = await pane()
  await ui.input({ key: 'dangerPercent', text: '50' })
  await ui.unmount()
  expect(sets).toEqual([])
  shown = await notice(/^Danger threshold: must be above the warning threshold \(50\)$/)
  expect(shown.found).toBeDefined()
  expect(shown.values).toEqual(['50', '90'])

  // Compared with what the pane shows: once the danger is raised, a warning
  // past the former one is taken.
  ui = await pane()
  await ui.input({ key: 'dangerPercent', text: '95' })
  await ui.input({ key: 'warnPercent', text: '92' })
  await ui.unmount()
  expect(sets).toEqual([
    { key: 'usage-bar.dangerPercent', value: 95 },
    { key: 'usage-bar.warnPercent', value: 92 },
  ])
  expect(toasts).toEqual([])
  expect((await notice(/doit/)).found).toBeUndefined()
})

test(
  'falls back to both default thresholds on a crossed pair',
  { options: { warnPercent: 80, dangerPercent: 60 } },
  async ($, on) => {
    mock.store(on)
    const quota: Quota = { percent: 70, resetsAt: '1970-01-01T05:00:00Z' }
    const { refresh } = WATCH($, on, quota)

    await refresh()
    const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
    const found = await ui.find({ type: 'Text', text: /^70%$/ })
    await ui.unmount()
    // Past the default warning of 50, under the default danger of 90: neither
    // green (warning at 80) nor red (danger at 60).
    expect(found?.props.color).toBe('#ff8c00')
  },
)

// The week's window, half of it gone by at the clock's start.
const HALF_WEEK = '1970-01-04T12:00:00Z'
const paces = (texts: readonly unknown[]) => texts.filter(t => typeof t === 'string' && /[▲▼]/.test(t))

test('says how far the week runs ahead of or behind an even pace', async ($, on) => {
  mock.store(on)
  const quota: Quota = { kind: 'seven_day', percent: 62, resetsAt: HALF_WEEK }
  const { refresh, texts } = WATCH($, on, quota)

  // 62% used with half the week gone: 12 points ahead, in the warning color,
  // right after the percentage.
  await refresh()
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const ahead = await ui.find({ type: 'Text', text: /▲/ })
  await ui.unmount()
  expect(ahead?.text).toBe(' ▲+12')
  expect(ahead?.props.color).toBe('#ff8c00')
  expect(shown[shown.indexOf(' ▲+12') - 1]).toBe('62%')

  // Under five points either way: nothing.
  quota.percent = 54
  await refresh(30000)
  expect(paces(await texts())).toEqual([])
  quota.percent = 46
  await refresh(30000)
  expect(paces(await texts())).toEqual([])

  // Behind: in the ok color.
  quota.percent = 42
  await refresh(30000)
  const again = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  const behind = await again.find({ type: 'Text', text: /▼/ })
  await again.unmount()
  expect(behind?.text).toBe(' ▼-8')
  expect(behind?.props.color).toBe('green')
})

test('says no pace on the session window', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 62, resetsAt: HALF_WEEK }
  const { refresh, texts } = WATCH($, on, quota)

  await refresh()
  const shown = await texts()
  expect(shown).toContain('62%')
  expect(paces(shown)).toEqual([])
})

test('hides the weekly pace when showPace is off', { options: { showPace: false } }, async ($, on) => {
  mock.store(on)
  const quota: Quota = { kind: 'seven_day', percent: 62, resetsAt: HALF_WEEK }
  const { refresh, texts } = WATCH($, on, quota)

  await refresh()
  const shown = await texts()
  expect(shown).toContain('62%')
  expect(paces(shown)).toEqual([])
})

const projected = (toasts: readonly string[]) => toasts.filter(t => t.includes('full in'))

// A session window that climbs fast enough to be full 17 minutes on, then a
// new cycle that does it again.
const CLIMB = async (quota: Quota, refresh: (wait?: number) => Promise<void>) => {
  await refresh()
  quota.percent = 30
  await refresh(5 * MINUTE)
}

test('toasts once in a cycle when the session quota is projected full soon', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { toasts, refresh } = WATCH($, on, quota)

  // Full in 35 minutes: past the 30 of the setting, nothing is said.
  await CLIMB(quota, refresh)
  expect(projected(toasts)).toEqual([])

  // 3 points a minute over ten minutes, 50 left: full in 17 minutes.
  quota.percent = 50
  await refresh(5 * MINUTE)
  expect(projected(toasts)).toEqual(['Session quota: full in 17m at the current pace'])

  // Said once, however the cycle goes on.
  quota.percent = 60
  await refresh(MINUTE)
  quota.percent = 70
  await refresh(MINUTE)
  expect(projected(toasts)).toHaveLength(1)

  // The next cycle says its own.
  quota.resetsAt = '1970-01-01T10:00:00Z'
  quota.percent = 5
  await refresh(MINUTE)
  expect(projected(toasts)).toHaveLength(1)
  quota.percent = 45
  await refresh(5 * MINUTE)
  expect(projected(toasts)).toHaveLength(2)
  expect(projected(toasts)[1]).toBe('Session quota: full in 7m at the current pace')
})

test(
  'raises no projection alert when projectionAlertMinutes is 0',
  { options: { projectionAlertMinutes: 0 } },
  async ($, on) => {
    mock.store(on)
    const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
    const { toasts, refresh, texts } = WATCH($, on, quota)

    await CLIMB(quota, refresh)
    quota.percent = 50
    await refresh(5 * MINUTE)
    expect(projected(toasts)).toEqual([])
    // The band still shows the projection.
    expect(projections(await texts())).toEqual([' full in 17m'])
  },
)

test(
  'raises the projection alert on a band that hides the projection',
  { options: { showProjection: false } },
  async ($, on) => {
    mock.store(on)
    const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
    const { toasts, refresh, texts } = WATCH($, on, quota)

    await CLIMB(quota, refresh)
    quota.percent = 50
    await refresh(5 * MINUTE)
    expect(projected(toasts)).toHaveLength(1)
    expect(projections(await texts())).toEqual([])
  },
)

test('toasts when the context crosses a threshold, and again after it fell back', async ($, on) => {
  mock.store(on)
  let sessionId = 'session-1'
  on('session.id', () => ({ value: sessionId }))
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z', contextPercent: 70 }
  const { toasts, refresh } = WATCH($, on, quota)

  await refresh()
  expect(toasts).toEqual([])

  // Past 80: said once, however often the band refreshes above it.
  quota.contextPercent = 82
  await refresh(30000)
  expect(toasts).toEqual(['Context: 80% reached'])
  quota.contextPercent = 88
  await refresh(30000)
  await refresh(30000)
  expect(toasts).toHaveLength(1)

  // Another session of the machine has its own context, hence its own alert.
  sessionId = 'session-2'
  await refresh(30000)
  expect(toasts).toHaveLength(2)
  sessionId = 'session-1'
  await refresh(30000)
  expect(toasts).toHaveLength(2)

  // /compact brings it back under: the alert is armed again.
  quota.contextPercent = 40
  await refresh(30000)
  expect(toasts).toHaveLength(2)
  quota.contextPercent = 81
  await refresh(30000)
  expect(toasts).toHaveLength(3)
  expect(toasts[2]).toBe('Context: 80% reached')
})

test('raises no context alert when contextAlerts is empty', { options: { contextAlerts: '' } }, async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'session-1' }))
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z', contextPercent: 95 }
  const { toasts, refresh, texts } = WATCH($, on, quota)

  await refresh()
  await refresh(30000)
  expect(toasts).toEqual([])
  expect(await texts()).toContain('95%')
})

test('raises no context alert for a context the band hides', { options: { showContext: false } }, async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'session-1' }))
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z', contextPercent: 95 }
  const { toasts, refresh } = WATCH($, on, quota)

  await refresh()
  expect(toasts).toEqual([])
})

test('names up to two subagents, and counts them past that', async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 20, resetsAt: '1970-01-01T05:00:00Z' }
  const { refresh, texts } = WATCH($, on, quota)
  const agent = (at: number, type: string) => ({ id: `agent-run-${at}`, description: '', type, status: 'running' })
  let agents = [agent(1, 'Explore'), agent(2, 'Plan')]
  on('agent.list', () => ({ value: agents }) as never)
  on('process.run', () => RUN('', 128))

  // Two: one segment each.
  await refresh()
  expect(activities(await texts())).toEqual(['▶ Explore 0m', '▶ Plan 0m'])

  // Four: a single segment, with the minutes of the oldest.
  agents = [...agents, agent(3, 'tester'), agent(4, 'reviewer-high')]
  await refresh(3 * MINUTE)
  expect(activities(await texts())).toEqual(['▶ 4 agents 3m'])

  // Back to two: named again.
  agents = agents.slice(2)
  await refresh(MINUTE)
  expect(activities(await texts())).toEqual(['▶ tester 1m', '▶ reviewer-high 1m'])
})

test('opens /usage and /cost from the segments of listed commands', async ($, on) => {
  const { clock, asked } = await PRESSABLE($, on, false, {
    listed: ['usage', 'cost', 'model'],
    costUsd: 1.234,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    asked.length = 0
    const ui = await $.ui.mount({ ...BAND, surface, props: { hasSurvey: false, isWorking: false } as never })

    // Each quota's icon is its own button, plain and without a hotkey.
    for (const [key, label] of [
      ['usage-five_hour', '⌛'],
      ['usage-seven_day', '📅'],
      ['usage-fable', 'F'],
    ] as const) {
      const icon = await ui.find({ type: 'Button', key })
      expect(icon?.props.label).toBe(label)
      expect(icon?.props.plain).toBe(true)
      expect(icon?.props.hotkey).toBeUndefined()
    }

    expect((await ui.find({ type: 'Button', key: 'cost' }))?.props.label).toBe('Σ $1.23')

    await ui.press({ key: 'usage-seven_day' })
    await ui.press({ key: 'cost' })
    await clock.advance(0)
    expect(asked).toEqual([{ command: 'usage' }, { command: 'cost' }])
    await ui.unmount()
  }
})

test('leaves a segment a plain text when its command is not listed', async ($, on) => {
  // /usage alone is listed: the cost stays a text.
  await PRESSABLE($, on, false, { listed: ['usage'], costUsd: 1.234 })
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  expect(await ui.find({ type: 'Button', key: 'usage-five_hour' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'cost' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^Σ \$1\.23$/ }))?.props.color).toBe('#8a8f98')
  await ui.unmount()
})

test('keeps every segment a plain text when the command list fails', async ($, on) => {
  await PRESSABLE($, on, false, { listed: null, costUsd: 1.234 })
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
  // The gear and the context icon alone, as before.
  expect(buttons).toEqual(['⚙', '🧠'])
  expect(await ui.find({ type: 'Text', text: /^⌛ $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
  await ui.unmount()
})

test(
  'reads the alert and pace settings from the options and changes them from the pane',
  { options: { projectionAlertMinutes: 45, contextAlerts: '90, 70', showPace: false } },
  async ($, on) => {
    const { sets } = SETTINGS(on)
    await SLASH($, 'config')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect((await ui.find({ type: 'Input', key: 'projectionAlertMinutes' }))?.props.value).toBe('45')
    expect((await ui.find({ type: 'Input', key: 'contextAlerts' }))?.props.value).toBe('70,90')
    expect((await ui.find({ type: 'Select', key: 'showPace' }))?.props.value).toBe('off')
    expect((await ui.find({ type: 'Select', key: 'showPace' }))?.props.label).toBe('Show weekly pace')

    await ui.input({ key: 'projectionAlertMinutes', text: ' 20 ' })
    await ui.input({ key: 'projectionAlertMinutes', text: '0' })
    await ui.input({ key: 'contextAlerts', text: '' })
    await ui.select({ key: 'showPace', value: 'on' })
    // Minutes that do not fit never reach the writer.
    for (const text of ['601', '1.5', '-1', 'soon', '']) {
      await ui.input({ key: 'projectionAlertMinutes', text })
    }
    expect(sets).toEqual([
      { key: 'usage-bar.projectionAlertMinutes', value: 20 },
      { key: 'usage-bar.projectionAlertMinutes', value: 0 },
      { key: 'usage-bar.contextAlerts', value: '' },
      { key: 'usage-bar.showPace', value: true },
    ])
    await ui.unmount()

    const again = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect((await again.find({ type: 'Input', key: 'projectionAlertMinutes' }))?.props.value).toBe('0')
    expect((await again.find({ type: 'Select', key: 'showPace' }))?.props.value).toBe('on')
    expect(
      await again.find({ type: 'Text', text: /^Projection alert \(minutes\): expects a whole number from 0 to 600/ }),
    ).toBeDefined()
    await again.unmount()
  },
)

// "17:00:05" in local time, as /usage-bar status says an instant.
const CLOCK = (at: number) => {
  const d = new Date(at)

  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// A session whose usage endpoint answers as `state` says: how many requests
// went out, and a refresh after `wait` milliseconds.
type Account = { claude: 'ok' | 'refused' }

const ACCOUNT = ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], state: Account) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  const asked = { requests: 0 }
  on('session.cwd', () => ({ value: '/home/me/Projects' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => {
    asked.requests += 1

    return {
      value:
        state.claude === 'ok'
          ? { status: 200, ok: true, headers: {}, text: USAGE }
          : { status: 429, ok: false, headers: {}, text: '{}' },
    }
  })
  const refresh = async (wait = 0) => {
    await clock.advance(wait)
    await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['rateLimits'] })
    await clock.advance(0)
  }

  return { asked, refresh, clock }
}

test('says the layout and the last answer on /usage-bar status', async ($, on) => {
  const state: Account = { claude: 'ok' }
  const { asked, refresh, clock } = ACCOUNT($, on, state)
  // The mocked clock starts at 0.
  const now = 0

  await refresh()
  const requests = asked.requests
  expect(requests).toBe(1)
  const answer = (await SLASH($, ' Status ')) ?? ''
  await clock.advance(0)
  const lines = answer.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toBe('usage-bar: layout full')
  expect(lines[1]).toBe(`Claude: last valid answer at ${CLOCK(now)}, next try in 30 s`)
  // The command asked no endpoint.
  expect(asked.requests).toBe(requests)

  // The endpoint refuses: the figure is kept, and the line says its next try.
  state.claude = 'refused'
  await refresh(30000)
  await clock.advance(20000)
  const refused = ((await SLASH($, 'status')) ?? '').split('\n')
  expect(refused[1]).toBe(
    `Claude: last valid answer at ${CLOCK(now)}, figure kept after a refusal (HTTP 429), next try in 100 s`,
  )
  expect(asked.requests).toBe(requests + 1)
})

test('says an endpoint that never answered on /usage-bar status', async ($, on) => {
  const state: Account = { claude: 'refused' }
  const { asked, refresh } = ACCOUNT($, on, state)

  // Before any refresh: nothing is known, and nothing throws.
  expect(await SLASH($, 'status')).toBe('usage-bar: layout full\nClaude: not asked yet')

  await refresh()
  const lines = ((await SLASH($, 'status')) ?? '').split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('Claude: no valid answer received, last request refused (HTTP 429), next try in 120 s')
  expect(asked.requests).toBe(1)
})

test('draws a single line under the compact layout', { options: { layout: 'compact' } }, async ($, on) => {
  mock.store(on)
  const { refresh } = WATCH($, on, { percent: 20, resetsAt: '1970-01-01T05:00:00Z' })
  on('process.run', (_, e) => (e.argv.includes('--abbrev-ref') ? RUN('main\n') : RUN('', 128)))

  await refresh()
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  const line = JSON.stringify(await ui.find({ key: 'compact' }))
  // Project, model and its gear, then the figures: one line, no branch.
  expect(line).toContain('Projects')
  expect(line).toContain('Opus-5.5')
  expect(line).toContain('⚙')
  expect(line).toContain('20%')
  expect(line).not.toContain('main')
  expect(await ui.find({ key: 'head' })).toBeUndefined()
  expect(await ui.find({ key: 'figures' })).toBeUndefined()
  await ui.unmount()
})

test('draws nothing under the hidden layout, and still raises the alerts', { options: { layout: 'hidden' } }, async ($, on) => {
  mock.store(on)
  const quota: Quota = { percent: 49, resetsAt: '1970-01-01T05:00:00Z' }
  const { toasts, refresh, texts } = WATCH($, on, quota)
  on('ui.render', () => ({ type: 'Box' }) as never)

  await refresh()
  quota.percent = 51
  await refresh()
  expect(await texts()).toEqual([])
  expect(toasts).toEqual(['Session quota: 50% reached (resets in 5h00)'])
})

// What `$.config.set` was asked, answered as `answer` says.
const LAYOUT_WRITER = (on: Parameters<TestBody>[1], answer: Answer = {}) => {
  const sets: { key: string; value: unknown }[] = []
  on('config.set', (_, e) => {
    sets.push({ key: e.key, value: e.value })

    if (answer.rejects) {
      throw new Error('no such row')
    }

    return answer.deny === undefined ? { value: e.value } : { deny: answer.deny }
  })

  return sets
}

test('writes the layout setting on hide, show, full and compact', { options: { layout: 'compact' } }, async ($, on) => {
  mock.store(on)
  const { refresh, texts } = WATCH($, on, { percent: 20, resetsAt: '1970-01-01T05:00:00Z' })
  const sets = LAYOUT_WRITER(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('ui.render', () => ({ type: 'Box' }) as never)
  const lines = async () => {
    const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
    const found = [
      (await ui.find({ key: 'compact' })) === undefined ? '' : 'compact',
      (await ui.find({ key: 'head' })) === undefined ? '' : 'head',
    ].join('')
    await ui.unmount()

    return found
  }

  await $.session.start({ source: 'startup', cwd: '/home/me/Projects' } as never)
  await refresh()
  expect(await lines()).toBe('compact')

  // Hidden through the setting, so it lasts; shown again as it was.
  expect(await SLASH($, 'hide')).toMatch(/^usage-bar: band hidden \(/)
  expect(sets).toEqual([{ key: 'usage-bar.layout', value: 'hidden' }])
  expect(await texts()).toEqual([])
  expect(await SLASH($, 'status')).toMatch(/layout hidden\n/)
  // Hidden already: nothing is written again.
  expect(await SLASH($, 'hide')).toMatch(/^usage-bar: band hidden \(/)
  expect(sets).toHaveLength(1)
  expect(await SLASH($, 'show')).toBe('usage-bar: band shown')
  expect(sets[1]).toEqual({ key: 'usage-bar.layout', value: 'compact' })
  expect(await lines()).toBe('compact')

  // No argument toggles.
  expect(await SLASH($, '')).toMatch(/^usage-bar: band hidden \(/)
  expect(await texts()).toEqual([])
  expect(await SLASH($, '')).toBe('usage-bar: band shown')
  expect(sets.slice(2)).toEqual([
    { key: 'usage-bar.layout', value: 'hidden' },
    { key: 'usage-bar.layout', value: 'compact' },
  ])

  // The layout by name; the one in place is not written again.
  expect(await SLASH($, 'full')).toBe('usage-bar: layout full')
  expect(await lines()).toBe('head')
  expect(await SLASH($, 'full')).toBe('usage-bar: layout full')
  expect(await SLASH($, ' Compact ')).toBe('usage-bar: layout compact')
  expect(await lines()).toBe('compact')
  expect(sets.slice(4)).toEqual([
    { key: 'usage-bar.layout', value: 'full' },
    { key: 'usage-bar.layout', value: 'compact' },
  ])

  // An unknown argument writes nothing.
  expect(await SLASH($, 'tiny')).toMatch(/^Usage: \/usage-bar /)
  expect(sets).toHaveLength(6)
})

test('keeps the last layout drawn without any hide', { options: { layout: 'compact' } }, async ($, on) => {
  const kept = new Map<string, unknown>()
  on('store.set', (_, e) => {
    kept.set(e.key, e.value)

    return { value: undefined }
  })
  const { refresh } = WATCH($, on, { percent: 20, resetsAt: '1970-01-01T05:00:00Z' })
  LAYOUT_WRITER(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)

  // Kept at the session start: a band hidden from the pane is shown as it was.
  await $.session.start({ source: 'startup', cwd: '/home/me/Projects' } as never)
  await refresh()
  expect(kept.get('layout-before-hide')).toBe('compact')

  expect(await SLASH($, 'full')).toBe('usage-bar: layout full')
  expect(kept.get('layout-before-hide')).toBe('full')
})

test('hides the band for the session when the layout setting cannot be written', async ($, on) => {
  mock.store(on)
  const { refresh, texts } = WATCH($, on, { percent: 20, resetsAt: '1970-01-01T05:00:00Z' })
  const answer: Answer = { rejects: true }
  const sets = LAYOUT_WRITER(on, answer)
  on('ui.render', () => ({ type: 'Box' }) as never)

  await refresh()
  expect(await SLASH($, 'hide')).toMatch(/^usage-bar: band hidden for this session only, setting not saved/)
  expect(sets).toEqual([{ key: 'usage-bar.layout', value: 'hidden' }])
  expect(await texts()).toEqual([])
  expect(await SLASH($, 'status')).toMatch(/layout full \(hidden for this session\)\n/)
  // Shown again without writing: the setting never changed.
  expect(await SLASH($, 'show')).toBe('usage-bar: band shown')
  expect(sets).toHaveLength(1)
  expect(await texts()).toContain('20%')

  // A `{ deny }` is said with its reason, and the layout stays.
  answer.rejects = false
  answer.deny = 'locked by policy'
  expect(await SLASH($, 'compact')).toBe(
    'usage-bar: layout unchanged (full), setting refused (locked by policy)',
  )
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false } as never })
  expect(await ui.find({ key: 'head' })).toBeDefined()
  await ui.unmount()
})

test(
  'shows a sample beside a color the band can draw, and none beside another',
  { options: { colorOk: 'not a color', colorDanger: '#f00' } },
  async ($, on) => {
    SETTINGS(on)
    await SLASH($, 'config')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    // The harness keeps no key on a Text: the samples are read by their text,
    // in the order of the fields, and their rows by key.
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.filter(t => t.text === ' ███').map(t => t.props.color)).toEqual(['#ff8c00', '#f00'])
    expect(texts.filter(t => t.text === ' sample ').map(t => t.props.backgroundColor)).toEqual(['#0d0f14'])
    expect(await ui.find({ type: 'Input', key: 'colorOk' })).toBeDefined()
    expect(await ui.find({ key: 'row-colorOk' })).toBeUndefined()
    expect(await ui.find({ key: 'row-colorDanger' })).toBeDefined()
    // A field that is no color has none.
    expect(await ui.find({ key: 'row-warnPercent' })).toBeUndefined()
    await ui.unmount()
  },
)

test(
  'puts every setting back to its default from the pane',
  { options: { warnPercent: 70, colorOk: '#0f0', quotaAlerts: '60', showGit: false, layout: 'compact' } },
  async ($, on) => {
    const answer: Answer = {}
    const { sets, toasts } = SETTINGS(on, answer)
    await SLASH($, 'config')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect((await ui.find({ type: 'Button', key: 'defaults' }))?.props.label).toBe('Defaults')
    await ui.press({ key: 'defaults' })
    // Only what differs is written.
    expect(sets).toEqual([
      { key: 'usage-bar.warnPercent', value: 50 },
      { key: 'usage-bar.colorOk', value: 'green' },
      { key: 'usage-bar.quotaAlerts', value: '50,80,90' },
      { key: 'usage-bar.showGit', value: true },
      { key: 'usage-bar.layout', value: 'full' },
    ])
    await ui.unmount()

    const again = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect((await again.find({ type: 'Input', key: 'warnPercent' }))?.props.value).toBe('50')
    expect((await again.find({ type: 'Input', key: 'colorOk' }))?.props.value).toBe('green')
    expect((await again.find({ type: 'Select', key: 'showGit' }))?.props.value).toBe('on')
    expect((await again.find({ type: 'Select', key: 'layout' }))?.props.value).toBe('full')

    // Already the defaults: nothing more is written.
    await again.press({ key: 'defaults' })
    expect(sets).toHaveLength(5)

    // A refusal is said in the pane, and the value stays.
    answer.deny = 'locked by policy'
    await again.input({ key: 'dangerPercent', text: '95' })
    answer.deny = undefined
    await again.input({ key: 'dangerPercent', text: '95' })
    answer.deny = 'locked by policy'
    await again.press({ key: 'defaults' })
    expect(toasts).toEqual([])
    await again.unmount()

    const last = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect((await last.find({ type: 'Input', key: 'dangerPercent' }))?.props.value).toBe('95')
    expect(
      await last.find({ type: 'Text', text: /^Defaults: 1 refused \(Danger threshold: locked by policy\)$/ }),
    ).toBeDefined()
    await last.unmount()
  },
)
