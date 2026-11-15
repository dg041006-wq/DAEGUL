import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import { SessionProvider, useSession } from "./lib/session";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Invite } from "./pages/Invite";
import { Home } from "./pages/Home";
import { Inbox } from "./pages/Inbox";
import { Pipeline, OpportunityDetail } from "./pages/Pipeline";
import { Analytics } from "./pages/Analytics";
import { StaffRoom, StaffChat } from "./pages/Staff";
import { Reports, ReportDetail } from "./pages/Reports";
import { Tasks } from "./pages/Tasks";
import { Notifications } from "./pages/Notifications";
import { Settings } from "./pages/Settings";
import { More } from "./pages/More";
import { Schedule, ProjectDetail, ProjectNew } from "./pages/Work";
import { Contacts, ContactDetail, Settlement, Ideas, Search, Install } from "./pages/More2";
import { Loading } from "./components/common";

function App() {
  const { me, loading } = useSession();
  if (loading) return <Loading />;
  return (
    <Routes>
      <Route path="/invite/:token" element={<Invite />} />
      {!me ? (
        <Route path="*" element={<Login />} />
      ) : (
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="inbox/:id" element={<Inbox />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="pipeline/:id" element={<OpportunityDetail />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="staff" element={<StaffRoom />} />
          <Route path="staff/:role" element={<StaffChat />} />
          <Route path="staff/:role/:threadId" element={<StaffChat />} />
          <Route path="reports" element={<Reports />} />
          <Route path="reports/:id" element={<ReportDetail />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="settings" element={<Settings />} />
          <Route path="more" element={<More />} />
          <Route path="schedule" element={<Schedule />} />
          <Route path="projects/new" element={<ProjectNew />} />
          <Route path="projects/:id" element={<ProjectDetail />} />
          <Route path="contacts" element={<Contacts />} />
          <Route path="contacts/:id" element={<ContactDetail />} />
          <Route path="settlement" element={<Settlement />} />
          <Route path="ideas" element={<Ideas />} />
          <Route path="search" element={<Search />} />
          <Route path="install" element={<Install />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      )}
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);


