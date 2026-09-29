import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import VoiceDemoApp from "./voice/VoiceDemoApp.jsx";

const root = createRoot(document.getElementById("root"));
if (import.meta.env.MODE === "operator" && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname)) {
  const { default: OperatorVoiceApp } = await import("./research/OperatorVoiceApp.jsx");
  root.render(<StrictMode><OperatorVoiceApp /></StrictMode>);
} else {
  root.render(<StrictMode><VoiceDemoApp /></StrictMode>);
}
