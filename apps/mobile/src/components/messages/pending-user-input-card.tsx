import type { UserQuestion } from "@zuse/wire";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/cn";

export type QuestionAnswer = {
  questionIndex: number;
  selected: readonly number[];
  other?: string;
};

/**
 * Inline card for an `AskUserQuestion` prompt — option pills (single- or
 * multi-select per question) plus a free-text "Other" field. Not a modal: it
 * lives in the message stream and submits via the session answer RPC.
 */
export const PendingUserInputCard = ({
  itemId,
  questions,
  onSubmit
}: {
  itemId: string;
  questions: readonly UserQuestion[];
  onSubmit: (itemId: string, answers: readonly QuestionAnswer[]) => void | Promise<void>;
}) => {
  const [selected, setSelected] = useState<number[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const [submitting, setSubmitting] = useState(false);

  const toggle = (qi: number, oi: number, multi: boolean) => {
    setSelected((prev) =>
      prev.map((picks, index) => {
        if (index !== qi) return picks;
        if (!multi) return picks.includes(oi) ? [] : [oi];
        return picks.includes(oi) ? picks.filter((value) => value !== oi) : [...picks, oi];
      })
    );
  };

  const answerable = questions.every(
    (_, qi) => (selected[qi] ?? []).length > 0 || (other[qi] ?? "").trim().length > 0
  );

  const submit = async () => {
    if (!answerable || submitting) return;
    setSubmitting(true);
    try {
      const answers: QuestionAnswer[] = questions.map((_, qi) => {
        const trimmed = (other[qi] ?? "").trim();
        return {
          questionIndex: qi,
          selected: selected[qi] ?? [],
          ...(trimmed.length > 0 ? { other: trimmed } : {})
        };
      });
      await onSubmit(itemId, answers);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View className="px-3 py-1.5">
      <View
        style={{ borderCurve: "continuous" }}
        className="rounded-2xl border border-primary/40 bg-card px-3 py-3"
      >
        <Text className="font-sans-medium text-xs text-primary">Question</Text>
        {questions.map((question, qi) => (
          <View key={`${itemId}-${qi}`} className={qi > 0 ? "mt-4" : "mt-1"}>
            <Text className="font-sans-medium text-sm text-foreground">{question.question}</Text>
            <View className="mt-2 flex-row flex-wrap gap-2">
              {question.options.map((option, oi) => {
                const active = (selected[qi] ?? []).includes(oi);
                return (
                  <Pressable
                    key={`${itemId}-${qi}-${oi}`}
                    onPress={() => toggle(qi, oi, question.multiSelect === true)}
                    style={{ borderCurve: "continuous" }}
                    className={cn(
                      "rounded-full border px-3 py-1.5 active:opacity-80",
                      active ? "border-primary bg-primary" : "border-border bg-card-elevated"
                    )}
                  >
                    <Text
                      className={cn(
                        "font-sans text-[13px]",
                        active ? "text-primary-foreground" : "text-foreground"
                      )}
                    >
                      {option}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              className="mt-2 min-h-9 rounded-xl border border-border bg-card-elevated px-3 py-2 font-sans text-[15px] text-foreground"
              style={{ borderCurve: "continuous" }}
              placeholder="Other…"
              placeholderTextColor="hsl(72 4% 56%)"
              value={other[qi]}
              onChangeText={(value) =>
                setOther((prev) => prev.map((entry, index) => (index === qi ? value : entry)))
              }
            />
          </View>
        ))}
        <View className="mt-3 flex-row justify-end">
          <Button size="sm" disabled={!answerable || submitting} onPress={submit}>
            Submit
          </Button>
        </View>
      </View>
    </View>
  );
};
