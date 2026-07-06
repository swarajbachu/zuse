import { memo } from "react";
import { StyleSheet } from "react-native";
import MarkdownDisplay from "react-native-markdown-display";

import { colors } from "~/theme";

const SANS = "Inter_400Regular";
const SANS_MEDIUM = "Inter_600SemiBold";
const MONO = "GeistMono_400Regular";

// Theme-mapped styles for react-native-markdown-display. Keys are the library's
// rule names; anything unspecified inherits from `body`.
const markdownStyles = StyleSheet.create({
  body: {
    color: colors.fg,
    fontFamily: SANS,
    fontSize: 15,
    lineHeight: 22
  },
  heading1: { fontFamily: SANS_MEDIUM, fontSize: 22, lineHeight: 28, marginBottom: 6, marginTop: 8 },
  heading2: { fontFamily: SANS_MEDIUM, fontSize: 19, lineHeight: 25, marginBottom: 6, marginTop: 8 },
  heading3: { fontFamily: SANS_MEDIUM, fontSize: 17, lineHeight: 23, marginBottom: 4, marginTop: 6 },
  heading4: { fontFamily: SANS_MEDIUM, fontSize: 15, lineHeight: 21, marginBottom: 4, marginTop: 6 },
  heading5: { fontFamily: SANS_MEDIUM, fontSize: 14, lineHeight: 20 },
  heading6: { fontFamily: SANS_MEDIUM, fontSize: 13, lineHeight: 19, color: colors.mutedFg },
  strong: { fontFamily: SANS_MEDIUM },
  em: { fontStyle: "italic" },
  link: { color: colors.accent, textDecorationLine: "underline" },
  blockquote: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderRadius: 6,
    marginVertical: 4,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  hr: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginVertical: 8 },
  bullet_list: { marginVertical: 2 },
  ordered_list: { marginVertical: 2 },
  code_inline: {
    backgroundColor: colors.card,
    borderRadius: 4,
    color: colors.fg,
    fontFamily: MONO,
    fontSize: 13,
    paddingHorizontal: 4,
    paddingVertical: 1
  },
  code_block: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.fg,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 19,
    marginVertical: 4,
    padding: 10
  },
  fence: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.fg,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 19,
    marginVertical: 4,
    padding: 10
  },
  table: { borderColor: colors.border, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, marginVertical: 4 },
  th: { fontFamily: SANS_MEDIUM, padding: 6 },
  td: { borderColor: colors.border, padding: 6 },
  tr: { borderColor: colors.border }
});

/**
 * Renders assistant markdown full-width with the app's typography and palette.
 * Memoized because assistant text is immutable once streamed.
 */
export const Markdown = memo(({ children }: { children: string }) => (
  <MarkdownDisplay style={markdownStyles}>{children}</MarkdownDisplay>
));

Markdown.displayName = "Markdown";
