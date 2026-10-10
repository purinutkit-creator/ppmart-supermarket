import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './styles.css';
import { ToastProvider, ApprovalProvider } from './components/ui';
import { getSession } from './lib/api';
import Login from './pages/Login';

const Pos = lazy(() => import('./pages/Pos'));
const Admin = lazy(() => import('./admin/AdminApp'));
const CustomerDisplay = lazy(() => import('./pages/CustomerDisplay'));
const MemberPortal = lazy(() => import('./pages/MemberPortal'));
const Shop = lazy(() => import('./pages/Shop'));

function useSession() {
  const [s, setS] = useState(getSession());
  useEffect(() => {
    const h = () => setS(getSession());
    window.addEventListener('ppmart-session', h);
    window.addEventListener('storage', h);
    return () => { window.removeEventListener('ppmart-session', h); window.removeEventListener('storage', h); };
  }, []);
  return s;
}

function RequireStaff({ children }: { children: React.ReactElement }) {
  const s = useSession();
  if (!s) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return children;
}

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="center muted" style={{ padding: '3rem' }}>กำลังโหลด…</div>}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/pos" element={<RequireStaff><Pos /></RequireStaff>} />
          <Route path="/admin/*" element={<RequireStaff><Admin /></RequireStaff>} />
          <Route path="/display" element={<CustomerDisplay />} />
          <Route path="/member/*" element={<MemberPortal />} />
          <Route path="/shop/*" element={<Shop />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ApprovalProvider>
        <App />
      </ApprovalProvider>
    </ToastProvider>
  </StrictMode>,
);
