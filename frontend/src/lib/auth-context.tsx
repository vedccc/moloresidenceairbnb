'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { setToken, clearToken } from '@/lib/api-client';

interface User {
  id: string;
  username: string;
  displayName: string | null;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (user: User, token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: () => {},
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const stored = localStorage.getItem('molo_session');
    if (stored) {
      try {
        setUser(JSON.parse(stored));
      } catch {
        localStorage.removeItem('molo_session');
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!loading && !user && pathname !== '/login') {
      router.replace('/login');
    }
  }, [loading, user, pathname, router]);

  const login = useCallback((u: User, token: string) => {
    localStorage.setItem('molo_session', JSON.stringify(u));
    setToken(token);
    setUser(u);
    router.replace('/');
  }, [router]);

  const logout = useCallback(() => {
    localStorage.removeItem('molo_session');
    clearToken();
    setUser(null);
    router.replace('/login');
  }, [router]);

  useEffect(() => {
    const handleUnauthorized = () => logout();
    window.addEventListener('molo:unauthorized', handleUnauthorized);
    return () => {
      window.removeEventListener('molo:unauthorized', handleUnauthorized);
    };
  }, [logout]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
