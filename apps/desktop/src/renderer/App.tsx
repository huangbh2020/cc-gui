import { ThreePaneLayout } from "./components/layout/ThreePaneLayout.js";
import { TopBar } from "./components/layout/TopBar.js";
import { StatusBar } from "./components/layout/StatusBar.js";
import { LeftBar } from "./components/layout/LeftBar.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { RightPanel } from "./components/layout/RightPanel.js";

export function App() {
  return (
    <div className="flex h-full w-full flex-col bg-zinc-950 text-zinc-100">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <ThreePaneLayout
          left={<LeftBar />}
          center={<ChatPane />}
          right={<RightPanel />}
        />
      </div>
      <StatusBar />
    </div>
  );
}
