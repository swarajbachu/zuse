import { Badge } from "./ui/badge";

export const UnreadBadge = ({ visible }: { visible: boolean }) =>
  visible ? <Badge tone="primary">NEW</Badge> : null;
