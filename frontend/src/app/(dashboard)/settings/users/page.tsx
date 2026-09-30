'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { fetchMe, updateMe } from '@/lib/me-api';

export default function AccountPage() {
  const queryClient = useQueryClient();
  const { data: me, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
  });

  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    if (me) setDisplayName(me.display_name ?? '');
  }, [me]);

  const saveMutation = useMutation({
    mutationFn: updateMe,
  });

  const submitting = saveMutation.isPending;

  async function handleSave() {
    setPasswordError(null);

    if (password || confirm) {
      if (password.length < 8) {
        setPasswordError('Password must be at least 8 characters.');
        return;
      }
      if (password !== confirm) {
        setPasswordError('Passwords do not match.');
        return;
      }
    }

    try {
      await saveMutation.mutateAsync({
        display_name: displayName.trim(),
        ...(password ? { password } : {}),
      });
    } catch (err) {
      toast.error(
        `Failed to update profile: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
      return;
    }

    toast.success('Profile updated');
    setPassword('');
    setConfirm('');
    queryClient.invalidateQueries({ queryKey: ['me'] });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your sign-in details for this dashboard.
        </p>
      </div>

      {isLoading || !me ? (
        <p className="text-sm text-muted-foreground">Loading account…</p>
      ) : (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>
              Update your display name or change your password.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" value={me.username} disabled readOnly />
            </div>

            <div className="space-y-2">
              <Label htmlFor="display-name">Display name</Label>
              <Input
                id="display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
              />
            </div>

            <div className="space-y-2 border-t pt-5">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank to keep current"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter new password"
              />
            </div>

            {passwordError && (
              <p className="text-sm text-destructive">{passwordError}</p>
            )}
          </CardContent>
          <CardFooter>
            <Button onClick={handleSave} disabled={submitting}>
              {submitting ? 'Saving…' : 'Save changes'}
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
