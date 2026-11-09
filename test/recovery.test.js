/**
 * Offline tests for dsh-recovery. They exercise the real command handler with a
 * fake Cordis context and a fake agent, so no DSH server or model call is
 * needed.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { ALPHABET, CODE_LENGTH, formatCode, generateCode, normalizeCode } from '../lib/code.js'
import { RecoveryStore, expandRecordDir, resolveDshHome } from '../lib/store.js'
import { buildSnapshot, formatTime, renderDigest } from '../lib/transcript.js'

const SAMPLE_CODE = 'ABCDEFGHJKLMNPQRSTUV'

/** Build a derived-message fixture. */
function message(role, content, extra = {}) {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role, content, source: { kind: 'user' }, ...extra }
}

/** Fake session exposing only the surface the plugin uses. */
function fakeSession(messages, { id = 'session-test', cwd = '/work/demo' } = {}) {
  return { id, header: { cwd }, deriveMessages: () => messages }
}

/** Fake agent that records injected messages and follow-ups. */
function fakeAgent(session, { canFollowup = true } = {}) {
  const injected = []
  const followups = []
  const agent = {
    session,
    injected,
    followups,
    inject: (entry) => { injected.push(entry) }
  }
  if (canFollowup) agent.followup = (entry) => { followups.push(entry) }
  return agent
}

/** Fake Cordis context that captures command registrations. */
function fakeCtx() {
  const registered = []
  return { registered, commands: { register: (definition) => registered.push(definition) } }
}

/** Invoke the captured `/recovery` handler. */
async function run(registered, agent, rawInput) {
  const definition = registered[0]
  assert.equal(definition.name, 'recovery')
  return definition.handler({ agent, rawInput, attachments: [], signal: new AbortController().signal, commandId: 'cmd-1' })
}

/** Extract the displayed code from a create confirmation. */
function codeFromText(text) {
  const match = /([A-Z]{5}-[A-Z]{5}-[A-Z]{5}-[A-Z]{5})/u.exec(text)
  assert.ok(match, `no code in output: ${text}`)
  return match[1]
}

/** Fresh record directory per test. */
async function tempStore(config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-recovery-test-'))
  return { dir, store: new RecoveryStore({ dir, ...config }) }
}

test('generated codes are 20 transcription-safe letters', () => {
  const code = generateCode()
  assert.equal(code.length, CODE_LENGTH)
  for (const letter of code) assert.ok(ALPHABET.includes(letter), `unexpected letter ${letter}`)
  assert.ok(!code.includes('I') && !code.includes('O'))

  const deterministic = generateCode(() => 0)
  assert.equal(deterministic, ALPHABET[0].repeat(CODE_LENGTH))
})

test('codes normalise from the shapes a user may type', () => {
  assert.deepEqual(normalizeCode('abcde-fghjk-lmnpq-rstuv'), { ok: true, code: SAMPLE_CODE })
  assert.deepEqual(normalizeCode('ABCDE FGHJK LMNPQ RSTUV'), { ok: true, code: SAMPLE_CODE })
  assert.deepEqual(normalizeCode('+ABCDEFGHJKLMNPQRSTUV'), { ok: true, code: SAMPLE_CODE })
  assert.equal(normalizeCode('ABCDE').ok, false)
  assert.equal(normalizeCode(`${SAMPLE_CODE}I`).ok, false)
  assert.equal(normalizeCode('ABCDEFGHJKLMNPQRSTU1').ok, false)
  assert.equal(normalizeCode('').ok, false)
})

test('formatCode groups five letters per block', () => {
  assert.equal(formatCode(SAMPLE_CODE), 'ABCDE-FGHJK-LMNPQ-RSTUV')
  assert.equal(formatCode('not-a-code'), 'not-a-code')
})

test('resolveDshHome follows DSH_HOME then ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/custom-home' }), '/tmp/custom-home')
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), join(process.env.HOME ?? '', '.dsh'))
})

test('snapshot drops system/developer prompts and keeps roles', () => {
  const snapshot = buildSnapshot([
    message('system', [{ type: 'text', text: 'system prompt' }]),
    message('developer', [{ type: 'text', text: 'tool addition' }]),
    message('user', [{ type: 'text', text: '帮我写插件' }]),
    message('assistant', [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: '好的' },
      { type: 'tool-call', name: 'bash', arguments: '{}' }
    ]),
    message('tool', [{ type: 'text', text: 'exit 0' }]),
    message('user', [{ type: 'image' }])
  ])
  assert.deepEqual(snapshot.messages.map((entry) => entry.role), ['user', 'assistant', 'tool', 'user'])
  assert.match(snapshot.messages[1].text, /好的/u)
  assert.match(snapshot.messages[1].text, /\[调用 bash\]/u)
  assert.equal(snapshot.messages[3].text, '[图片]')
  assert.equal(snapshot.stats.sourceMessages, 4)
  assert.equal(snapshot.stats.kept, 4)
  assert.equal(snapshot.title, '帮我写插件')
})

test('snapshot trims the oldest entries when over budget', () => {
  const messages = Array.from({ length: 20 }, (_, index) => message('user', [{ type: 'text', text: 'x'.repeat(200) }]))
  const snapshot = buildSnapshot(messages, { maxBytes: 1_000 })
  assert.ok(snapshot.messages.length < 20)
  assert.ok(snapshot.stats.omitted > 0)
  assert.ok(snapshot.stats.bytes <= 1_000)
})

test('digest keeps both ends under a small budget', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第${index}条消息 ${'细节'.repeat(30)}`
  }))
  const record = {
    code: SAMPLE_CODE,
    createdAt: '2026-11-09T14:20:00.000Z',
    title: '插件开发',
    stats: { sourceMessages: 40 },
    messages
  }
  const digest = renderDigest(record, 2_000)
  assert.equal(digest.omitted, 40 - digest.included)
  assert.ok(digest.omitted > 0)
  assert.ok(digest.text.length <= 2_100)
  assert.match(digest.text, /记忆开始/u)
  assert.match(digest.text, /记忆结束/u)
  assert.match(digest.text, /省略 \d+ 条较早消息/u)
  assert.match(digest.text, /第0条消息/u)
  assert.match(digest.text, /第39条消息/u)
})

test('store writes owner-only files and lists newest first', async () => {
  const { dir, store } = await tempStore()
  const first = await store.writeUnique((code) => ({
    version: 1,
    code,
    createdAt: '2026-11-09T10:00:00.000Z',
    messages: [{ role: 'user', text: 'older' }],
    stats: { kept: 1, bytes: 8 }
  }))
  const second = await store.writeUnique((code) => ({
    version: 1,
    code,
    createdAt: '2026-11-09T12:00:00.000Z',
    messages: [{ role: 'user', text: 'newer' }],
    stats: { kept: 1, bytes: 8 }
  }))

  const fileMode = (await stat(join(dir, `${first.code}.json`))).mode & 0o777
  assert.equal(fileMode, 0o600)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)

  const listed = await store.list()
  assert.deepEqual(listed.map((record) => record.code), [second.code, first.code])
  assert.equal((await store.read(first.code)).messages[0].text, 'older')
  assert.equal(await store.remove(first.code), true)
  assert.equal(await store.remove(first.code), false)
  assert.equal(await store.read(first.code), undefined)
})

test('digest and timestamps survive a round trip through the store', async () => {
  const { store } = await tempStore()
  const written = await store.writeUnique((code) => ({
    version: 1,
    code,
    createdAt: '2026-11-09T12:34:00.000Z',
    messages: [{ role: 'user', text: '今天在修插件' }],
    stats: { sourceMessages: 1, kept: 1, bytes: 18 }
  }))
  const read = await store.read(written.code)
  assert.match(renderDigest(read, 5_000).text, /今天在修插件/u)
  assert.match(formatTime(read.createdAt), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u)
})

test('/recovery create then /recovery memory restores the transcript', async () => {
  const { store } = await tempStore()
  const ctx = fakeCtx()
  apply(ctx, { dir: store.dir })

  const session = fakeSession([
    message('system', [{ type: 'text', text: 'system prompt' }]),
    message('user', [{ type: 'text', text: '我们在做一个记忆恢复插件' }]),
    message('assistant', [{ type: 'text', text: '好的，先设计恢复码格式。' }])
  ])
  const creator = fakeAgent(session)
  const created = await run(ctx.registered, creator, ' create')
  assert.equal(created.kind, 'success')
  const code = codeFromText(created.text)

  const restoredAgent = fakeAgent(fakeSession([]))
  const restored = await run(ctx.registered, restoredAgent, ` memory ${code}`)
  assert.equal(restored.kind, 'success')
  assert.equal(restoredAgent.injected.length, 1)
  const injected = restoredAgent.injected[0]
  assert.equal(injected.role, 'user')
  assert.equal(injected.source.kind, 'recovery')
  assert.equal(injected.source.code, normalizeCode(code).code)
  assert.match(injected.content[0].text, /我们在做一个记忆恢复插件/u)
  assert.match(injected.content[0].text, /好的，先设计恢复码格式/u)
  assert.match(injected.content[0].text, /不是本轮的新指令/u)
  assert.match(injected.content[0].text, /【请先总结】/u)
  assert.ok(Object.isFrozen(injected))

  // Restoring automatically asks the model to summarize the recovered session.
  assert.equal(restoredAgent.followups.length, 1)
  const followup = restoredAgent.followups[0]
  assert.equal(followup.role, 'user')
  assert.equal(followup.content[0].text, '请按要求总结上面恢复的这段会话，最后一行写「记忆已恢复」。')
  assert.equal(followup.source.kind, 'recovery')
  assert.equal(followup.source.summary, true)
  assert.match(restored.text, /模型正据此总结上一段会话/u)
  assert.ok(restored.text.trimEnd().endsWith('记忆已恢复。'), restored.text)
  assert.ok(restoredAgent.injected[0].content[0].text.trimEnd().endsWith('记忆已恢复。'))
})

test('memory shorthand accepts concatenated codes and bare codes', async () => {
  const { store } = await tempStore()
  const ctx = fakeCtx()
  apply(ctx, { dir: store.dir })
  const created = await run(ctx.registered, fakeAgent(fakeSession([message('user', [{ type: 'text', text: '记忆内容' }])])), 'create')
  const code = codeFromText(created.text)

  const concatenated = fakeAgent(fakeSession([]))
  assert.equal((await run(ctx.registered, concatenated, `memory${code.replaceAll('-', '')}`)).kind, 'success')
  assert.equal(concatenated.injected.length, 1)

  const bare = fakeAgent(fakeSession([]))
  assert.equal((await run(ctx.registered, bare, ` ${code.toLowerCase()}`)).kind, 'success')
  assert.equal(bare.injected.length, 1)
})

test('list and delete manage stored records', async () => {
  const { store } = await tempStore()
  const ctx = fakeCtx()
  apply(ctx, { dir: store.dir })

  const empty = await run(ctx.registered, fakeAgent(fakeSession([])), ' list')
  assert.match(empty.text, /还没有保存任何恢复记忆/u)

  const created = await run(ctx.registered, fakeAgent(fakeSession([message('user', [{ type: 'text', text: '要被列出' }])])), ' create 演示备注')
  assert.match(created.text, /演示备注/u)
  const code = codeFromText(created.text)

  const listed = await run(ctx.registered, fakeAgent(fakeSession([])), 'list')
  assert.match(listed.text, new RegExp(code, 'u'))
  assert.match(listed.text, /演示备注/u)

  const deleted = await run(ctx.registered, fakeAgent(fakeSession([])), `delete ${code}`)
  assert.equal(deleted.kind, 'success')
  const missing = await run(ctx.registered, fakeAgent(fakeSession([])), `memory ${code}`)
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /没有恢复码/u)
})

test('create refuses an empty conversation and bad codes are reported', async () => {
  const { store } = await tempStore()
  const ctx = fakeCtx()
  apply(ctx, { dir: store.dir })

  const empty = await run(ctx.registered, fakeAgent(fakeSession([])), 'create')
  assert.equal(empty.kind, 'error')
  assert.match(empty.text, /还没有可以恢复的内容/u)

  const bad = await run(ctx.registered, fakeAgent(fakeSession([])), 'memory ABC')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /格式不正确/u)

  const usage = await run(ctx.registered, fakeAgent(fakeSession([])), '')
  assert.equal(usage.kind, 'success')
  assert.match(usage.text, /用法/u)

  const unknown = await run(ctx.registered, fakeAgent(fakeSession([])), 'wat')
  assert.equal(unknown.kind, 'error')
})

test('stored records stay private and readable JSON', async () => {
  const { dir, store } = await tempStore()
  const ctx = fakeCtx()
  apply(ctx, { dir: store.dir })
  const created = await run(ctx.registered, fakeAgent(fakeSession([message('user', [{ type: 'text', text: 'secret' }])])), 'create')
  const code = codeFromText(created.text).replaceAll('-', '')
  const raw = await readFile(join(dir, `${code}.json`), 'utf8')
  const record = JSON.parse(raw)
  assert.equal(record.code, code)
  assert.equal(record.version, 1)
  assert.equal(record.messages[0].text, 'secret')
})

test('--no-summary restores without asking for a summary', async () => {
  const { store } = await tempStore()
  const ctx = fakeCtx()
  apply(ctx, { dir: store.dir })
  const created = await run(ctx.registered, fakeAgent(fakeSession([message('user', [{ type: 'text', text: '不要总结我' }])])), 'create')
  const code = codeFromText(created.text)

  const agent = fakeAgent(fakeSession([]))
  const restored = await run(ctx.registered, agent, `memory ${code} --no-summary`)
  assert.equal(restored.kind, 'success')
  assert.equal(agent.followups.length, 0)
  assert.doesNotMatch(agent.injected[0].content[0].text, /【请先总结】/u)
  assert.doesNotMatch(restored.text, /模型正据此总结/u)
})

test('autoSummary: false disables summaries at the profile level', async () => {
  const { store } = await tempStore()
  const ctx = fakeCtx()
  apply(ctx, { dir: store.dir, autoSummary: false })
  const created = await run(ctx.registered, fakeAgent(fakeSession([message('user', [{ type: 'text', text: '配置关闭' }])])), 'create')
  const code = codeFromText(created.text)

  const agent = fakeAgent(fakeSession([]))
  await run(ctx.registered, agent, `memory ${code}`)
  assert.equal(agent.followups.length, 0)
  assert.doesNotMatch(agent.injected[0].content[0].text, /【请先总结】/u)
})

test('restore still works when the agent cannot be woken for a summary', async () => {
  const { store } = await tempStore()
  const ctx = fakeCtx()
  apply(ctx, { dir: store.dir })
  const created = await run(ctx.registered, fakeAgent(fakeSession([message('user', [{ type: 'text', text: '没有 followup' }])])), 'create')
  const code = codeFromText(created.text)

  const agent = fakeAgent(fakeSession([]), { canFollowup: false })
  const restored = await run(ctx.registered, agent, `memory ${code}`)
  assert.equal(restored.kind, 'success')
  assert.equal(agent.injected.length, 1)
  assert.match(restored.text, /不支持自动总结/u)
})

test('digest carries the summary instruction only when asked', () => {
  const record = {
    code: SAMPLE_CODE,
    createdAt: '2026-11-09T14:20:00.000Z',
    stats: { sourceMessages: 2 },
    messages: [
      { role: 'user', text: '第一个问题' },
      { role: 'assistant', text: '第一个回答' }
    ]
  }
  const plain = renderDigest(record, 5_000)
  assert.equal(plain.summarized, false)
  assert.doesNotMatch(plain.text, /【请先总结】/u)

  const summarized = renderDigest(record, 5_000, { summarize: true })
  assert.equal(summarized.summarized, true)
  assert.match(summarized.text, /【请先总结】/u)
  assert.match(summarized.text, /尽量把关键信息都写出来/u)
  assert.ok(summarized.text.length <= 5_000)
})

test('default digest keeps long messages intact instead of compressing them', () => {
  const long = '这是一段很长的正文。'.repeat(600) // ~5400 chars, above the old 2400 cap
  const record = {
    code: SAMPLE_CODE,
    createdAt: '2026-11-09T14:20:00.000Z',
    stats: { sourceMessages: 2 },
    messages: [
      { role: 'user', text: '开始' },
      { role: 'assistant', text: long }
    ]
  }
  const digest = renderDigest(record, undefined, { summarize: true })
  assert.equal(digest.complete, true)
  assert.equal(digest.omitted, 0)
  assert.ok(digest.text.includes(long), 'long message must be preserved verbatim')
  assert.ok(digest.text.length > long.length)
  assert.ok(digest.text.trimEnd().endsWith('记忆已恢复。'))
  assert.doesNotMatch(digest.text, /本条过长，已截断/u)
})

test('oversized restores say what was left on disk instead of dropping it silently', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: 'user',
    text: `第${index}条 ${'内容'.repeat(100)}`
  }))
  const record = { code: SAMPLE_CODE, createdAt: '2026-11-09T14:20:00.000Z', stats: { sourceMessages: 40 }, messages }
  const digest = renderDigest(record, 4_000, { summarize: false })
  assert.equal(digest.complete, false)
  assert.ok(digest.omitted > 0)
  assert.match(digest.text, /本次载入 \d+\/40 条；其余 \d+ 条仍在本机的完整记录里/u)
  assert.ok(digest.text.trimEnd().endsWith('记忆已恢复。'))
})

test('the record directory can be pointed at another location', () => {
  assert.equal(expandRecordDir('/storage/emulated/0/Download/dsh-recovery'), '/storage/emulated/0/Download/dsh-recovery')
  assert.equal(expandRecordDir('~/sync/recovery'), join(homedir(), 'sync/recovery'))
  assert.equal(expandRecordDir('memories', { DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home/memories')

  const fromConfig = new RecoveryStore({ dir: '/tmp/custom-records' })
  assert.equal(fromConfig.dir, '/tmp/custom-records')
  assert.equal(fromConfig.dirSource, 'config')

  const fromEnv = new RecoveryStore({}, { DSH_HOME: '/tmp/dsh-home', DSH_RECOVERY_DIR: '/tmp/from-env' })
  assert.equal(fromEnv.dir, '/tmp/from-env')
  assert.equal(fromEnv.dirSource, 'env')

  const fallback = new RecoveryStore({}, { DSH_HOME: '/tmp/dsh-home' })
  assert.equal(fallback.dir, '/tmp/dsh-home/recovery')
  assert.equal(fallback.dirSource, 'default')
})

test('/recovery where reports the directory and how to move it', async () => {
  const { dir, store } = await tempStore()
  const ctx = fakeCtx()
  apply(ctx, { dir: store.dir })
  const out = await run(ctx.registered, fakeAgent(fakeSession([])), 'where')
  assert.equal(out.kind, 'success')
  assert.ok(out.text.includes(dir), out.text)
  assert.match(out.text, /配置项 dir/u)
  assert.match(out.text, /dir: \/storage\/emulated\/0\/Download\/dsh-recovery/u)
  assert.match(out.text, /可写/u)
})
