import { UserCircle } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { useAuth } from '../context/AuthContext';

type CurrentUserBadgeProps = {
  className?: string;
  iconClassName?: string;
  textClassName?: string;
};

export default function CurrentUserBadge({
  className,
  iconClassName,
  textClassName,
}: CurrentUserBadgeProps) {
  const { user } = useAuth();
  const username = typeof user?.username === 'string' ? user.username.trim() : '';

  if (!username) {
    return null;
  }

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted/35 px-2.5 py-1.5 text-muted-foreground',
        className,
      )}
      aria-label={`当前登录用户：${username}`}
      title={`当前登录用户：${username}`}
    >
      <UserCircle
        className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', iconClassName)}
        aria-hidden="true"
      />
      <span className={cn('min-w-0 truncate text-sm font-medium text-foreground', textClassName)}>
        {username}
      </span>
    </div>
  );
}
