const documents = new Map<string, string>();

export const putPlanDocument = (text: string): string => {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  documents.set(id, text);
  return id;
};

export const getPlanDocument = (id: string): string | null =>
  documents.get(id) ?? null;
