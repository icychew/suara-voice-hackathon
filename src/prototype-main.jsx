import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ShowcaseApp from "./showcase/ShowcaseApp.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ShowcaseApp />
  </StrictMode>,
);
