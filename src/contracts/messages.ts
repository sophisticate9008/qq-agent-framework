export interface TextContent { type: 'text'; text: string }
export interface ImageContent { type: 'image'; assetId: string }
export interface AudioContent { type: 'audio'; assetId: string }
export interface FileContent { type: 'file'; assetId: string; name: string }
export interface MentionContent { type: 'mention'; userId: string }
export interface ReplyContent { type: 'reply'; messageId: string }
export interface FaceContent { type: 'face'; id: string }
export interface ForwardReferenceContent { type: 'forward-reference'; assetId: string }
export type BasicMessageContent = TextContent | ImageContent | AudioContent | FileContent | MentionContent | ReplyContent | FaceContent | ForwardReferenceContent;
export interface ForwardNode { content: readonly BasicMessageContent[] }
export interface ForwardContent { type: 'forward'; nodes: readonly ForwardNode[] }
export type MessageContent = BasicMessageContent | ForwardContent;
