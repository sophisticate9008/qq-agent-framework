import type { Agent } from '@deepseek-ai/dsh-agent'

// These older bridge entry points duplicate the host's inbound queue, prompt,
// media channel, reply delivery or wake configuration. Keep their registrations
// intact for other presets; only trim agents carrying a framework tool lease.
const redundantBridgeTools = new Set([
  'mcp__snowluma__qq_wait_for_messages',
  'mcp__snowluma__qq_get_unread_messages',
  'mcp__snowluma__qq_get_recent_messages',
  'mcp__snowluma__qq_get_my_recent_messages',
  'mcp__snowluma__qq_mark_read',
  'mcp__snowluma__qq_get_prompt',
  'mcp__snowluma__qq_reply',
  'mcp__snowluma__qq_send_burst',
  'mcp__snowluma__qq_get_message_images',
  'mcp__snowluma__qq_set_wake_config',
  'mcp__snowluma__qq_status',
  'mcp__snowluma-host__snowluma_status',
])

/** This changes the prompt surface, not authorization or global installation. */
export function trimFrameworkChatTools(agent: Agent): (() => void) | undefined {
  // No scope argument reads global registrations, so absent and scope-local
  // tool names never enter restrict(), which rejects unknown inherited names.
  const deny = agent.ctx.tools.schemas().map(tool => tool.name).filter(name => redundantBridgeTools.has(name))
  return deny.length ? agent.ctx.tools.restrict({ deny }) : undefined
}
