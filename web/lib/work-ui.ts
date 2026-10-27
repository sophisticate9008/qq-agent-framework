import type { NativeWorkView } from '../../src/contracts/native-work.ts';
import type { MessageContent } from '../../src/contracts/messages.ts';

export const workStateLabels: Readonly<Record<NativeWorkView['status'], string>> = {
  starting: '正在启动', running: '处理中', completed: '执行完成', failed: '执行失败', unknown: '执行结果未知',
};
export const workDeliveryLabels: Readonly<Record<NativeWorkView['delivery'], string>> = {
  'not-requested': '尚未请求回传', delivering: '正在回传', confirmed: '回传已确认', rejected: '回传被拒绝', unknown: '回传结果未知', unavailable: '回传暂不可用',
};
export function workContentSummary(content: MessageContent): string {
  switch (content.type) {
    case 'text': return content.text;
    case 'face': return `QQ表情：${content.id}`;
    case 'image': return `图片资源：${content.assetId}`;
    case 'audio': return `音频资源：${content.assetId}`;
    case 'file': return `文件：${content.name}（资源 ${content.assetId}）`;
    case 'mention': return `提及账号：${content.userId}`;
    case 'reply': return `引用消息：${content.messageId}`;
    case 'forward-reference': return `转发资源：${content.assetId}`;
    case 'forward': return content.nodes.map(node => node.content.map(workContentSummary).join('\n')).join('\n\n');
  }
}
export function workTime(value: number): string {
  return value <= 8_640_000_000_000_000 ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间超出可显示范围';
}
