import { NavLink, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Campaigns from "./pages/Campaigns";
import Patients from "./pages/Patients";
import CallHistory from "./pages/CallHistory";

export default function App() {
  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">Care<span>Call</span></div>
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/campaigns">Campaigns</NavLink>
        <NavLink to="/patients">Patients</NavLink>
        <NavLink to="/history">Call history</NavLink>
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/patients" element={<Patients />} />
          <Route path="/history" element={<CallHistory />} />
        </Routes>
      </main>
    </div>
  );
}
