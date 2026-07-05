import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { SessionProvider } from "./lib/session";
import { ClinicProvider } from "./lib/clinic";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <ClinicProvider>
          <App />
        </ClinicProvider>
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
