export const CHAT_LIST_ANCHOR_OFFSET = 16;

export interface ChatListAnchoredEndSpace {
  readonly anchorIndex: number;
  readonly anchorOffset: number;
}

export function resolveChatListAnchoredEndSpace<Item, AnchorId>(
  items: ReadonlyArray<Item>,
  anchorId: AnchorId | null,
  getAnchorId: (item: Item) => AnchorId | null,
): ChatListAnchoredEndSpace | undefined {
  if (anchorId === null) return undefined;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && getAnchorId(item) === anchorId) {
      return {
        anchorIndex: index,
        anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
      };
    }
  }

  return undefined;
}
