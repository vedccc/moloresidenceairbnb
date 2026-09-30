'use client';

import { useAuth } from '@/lib/auth-context';
import { AppSidebar } from '@/components/app-sidebar';
import { UserMenu } from '@/components/user-menu';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  // AuthProvider's effect redirects to /login when there's no user; render nothing meanwhile.
  if (loading || !user) return null;

  return (
    <div className="flex min-h-screen">
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex h-14 shrink-0 items-center border-b px-6">
          <div className="flex-1" />
          <UserMenu displayName={user.displayName} />
        </header>
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
