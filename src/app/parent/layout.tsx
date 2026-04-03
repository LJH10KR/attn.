import { ParentChrome } from "./parent-chrome";

export default function ParentLayout({ children }: { children: React.ReactNode }) {
  return <ParentChrome>{children}</ParentChrome>;
}
