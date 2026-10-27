import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import { createSimulatedMembers, simulatedMemberIndex, startSimulatedOneBot } from '../scripts/simulate-qq-onebot.ts'
import { isRecord } from '../src/core/values.ts'

test('simulated member indexes preserve the default identity and avoid owner or bot collisions', () => {
  const members = createSimulatedMembers({ selfId: '900000000011', ownerId: '900000000010', memberId: '900000000002' })
  assert.equal(members.length, 8)
  assert.deepEqual(members[0], { memberIndex: 1, userId: '900000000002', nickname: '模拟群友' })
  assert.equal(new Set(members.map(member => member.userId)).size, 8)
  assert(members.every(member => !['900000000010', '900000000011'].includes(member.userId)))
  assert.equal(simulatedMemberIndex('member', undefined), 1)
  for (const invalid of [0, 9, -1, 1.5, '2', NaN])
    assert.throws(() => simulatedMemberIndex('member', invalid), /simulation_invalid_member_index/)
  assert.throws(() => simulatedMemberIndex('owner', 1), /simulation_invalid_member_index/)
  assert.throws(() => createSimulatedMembers({ selfId: '1', ownerId: '2', memberId: '2' }), /simulation_invalid_member_identity/)
})

test('local simulated group messages, member queries and history agree on eight independent nonowner identities', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'simulation-members-'))
  const peer = await startSimulatedOneBot({ selfId: '900000000001', ownerId: '123', memberId: '900000000002',
    groupId: '900000000003', directory, record() {} })
  const socket = new WebSocket(peer.websocketEndpoint, { headers: { authorization: `Bearer ${peer.secret}` } })
  context.after(async () => { socket.terminate(); await peer.close(); await rm(directory, { recursive: true, force: true }) })
  await once(socket, 'open')
  async function action(name: string, params: Record<string, unknown>) {
    const response = await fetch(`${peer.endpoint}/${name}`, { method: 'POST',
      headers: { authorization: `Bearer ${peer.secret}`, 'content-type': 'application/json' }, body: JSON.stringify(params),
      signal: AbortSignal.timeout(2000) })
    const result: unknown = await response.json()
    assert(isRecord(result))
    return result
  }
  const messageIds: number[] = []
  for (const memberIndex of [undefined, 2, 8]) {
    const received = once(socket, 'message')
    const input = { actor: 'member' as const, kind: 'group' as const, text: '独立群友发言', memberIndex,
      userId: '123', user_id: 123 }
    messageIds.push(peer.inject(input))
    const [bytes] = await received
    const event: unknown = JSON.parse(String(bytes))
    assert(isRecord(event) && isRecord(event.sender))
    const member = peer.members[(memberIndex ?? 1) - 1]!
    assert.equal(event.user_id, Number(member.userId))
    assert.equal(event.sender.nickname, member.nickname)
    assert.notEqual(event.user_id, 123, 'arbitrary input identity fields never impersonate the owner')
  }
  assert.throws(() => peer.inject({ actor: 'owner', memberIndex: 2, kind: 'group', text: 'invalid' }), /simulation_invalid_member_index/)
  const roster = await action('get_group_member_list', { group_id: '900000000003' })
  assert(Array.isArray(roster.data) && roster.data.every(isRecord))
  assert.equal(roster.data.length, 10)
  assert.equal(new Set(roster.data.map(member => member.user_id)).size, 10)
  for (const member of peer.members) {
    const detail = await action('get_group_member_info', { group_id: '900000000003', user_id: member.userId })
    assert(isRecord(detail.data))
    assert.equal(detail.data.nickname, member.nickname)
  }
  const bot = await action('get_group_member_info', { group_id: '900000000003', user_id: '900000000001' })
  assert(isRecord(bot.data))
  assert.equal(bot.data.nickname, '模拟机器人')
  const history = await action('get_group_msg_history', { group_id: '900000000003', count: 10 })
  assert(isRecord(history.data) && Array.isArray(history.data.messages) && history.data.messages.every(isRecord))
  assert.deepEqual(history.data.messages.map(message => message.user_id),
    [peer.members[0], peer.members[1], peer.members[7]].map(member => Number(member!.userId)))
  const quoted = await action('get_msg', { message_id: messageIds[1] })
  assert(isRecord(quoted.data) && isRecord(quoted.data.sender))
  assert.equal(quoted.data.sender.nickname, '模拟群友2')
  const poke = once(socket, 'message')
  peer.poke('member', { memberIndex: 8 })
  const [pokeBytes] = await poke
  const notice: unknown = JSON.parse(String(pokeBytes))
  assert(isRecord(notice))
  assert.equal(notice.user_id, Number(peer.members[7]!.userId))
  const file = join(directory, 'sample.txt')
  await writeFile(file, 'synthetic upload')
  const upload = once(socket, 'message')
  await peer.uploadGroupFile('member', file, { memberIndex: 2 })
  const [uploadBytes] = await upload
  const uploaded: unknown = JSON.parse(String(uploadBytes))
  assert(isRecord(uploaded))
  assert.equal(uploaded.user_id, Number(peer.members[1]!.userId))
})
