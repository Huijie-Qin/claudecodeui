import { parseBatchUsernames } from '../adminPanelUtils';

export type HookBindingUser = {
  id: number;
  username: string;
  isActive: boolean;
  isSystemAdmin: boolean;
  bound: boolean;
};

export type HookBindingTenant = {
  id: number;
  code: string;
  name: string;
  active: boolean;
  activeUserCount: number;
  bound: boolean;
};

export type HookBindingScope = 'users' | 'tenants' | 'all_users';

export function matchBindingUsernames(input: string, users: HookBindingUser[]) {
  const active = new Map(users.filter(user => user.isActive).map(user => [user.username.toLowerCase(), user.id]));
  const ids = new Set<number>();
  const missing: string[] = [];
  for (const name of parseBatchUsernames(input)) {
    const id = active.get(name.toLowerCase());
    if (id == null) missing.push(name);
    else ids.add(id);
  }
  return { ids: [...ids], missing };
}

export function bindingOptions(scope: HookBindingScope, users: HookBindingUser[], tenants: HookBindingTenant[]) {
  return scope === 'users'
    ? users.map(user => ({ id: user.id, name: user.username, detail: `ID ${user.id}`, active: user.isActive, admin: user.isSystemAdmin, memberCount: null as number | null }))
    : scope === 'tenants'
      ? tenants.map(tenant => ({ id: tenant.id, name: tenant.name, detail: tenant.code, active: tenant.active, admin: false, memberCount: tenant.activeUserCount }))
      : [];
}

export function filterBindingOptions(options: ReturnType<typeof bindingOptions>, query: string, selected: Set<number>, onlySelected: boolean) {
  const search = query.trim().toLowerCase();
  return options.filter(option => (!onlySelected || selected.has(option.id))
    && (!search || `${option.name}\n${option.detail}`.toLowerCase().includes(search)));
}

export function canSaveHookBindings(scope: HookBindingScope, count: number, overwrite: boolean, loading: boolean, saving: boolean) {
  return !loading && !saving && (scope !== 'tenants' || count > 0) && (!overwrite || count > 0);
}
