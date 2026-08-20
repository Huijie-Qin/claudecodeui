export function createProviderCommandActivity({ registry, key, value }) {
  if (!registry || typeof registry.set !== 'function' || typeof registry.delete !== 'function') {
    throw new TypeError('registry must support set and delete');
  }

  let active = false;

  return {
    activate() {
      if (active) return false;
      registry.set(key, value);
      active = true;
      return true;
    },
    deactivate() {
      if (!active) return false;
      registry.delete(key);
      active = false;
      return true;
    },
    isActive() {
      return active;
    },
  };
}
