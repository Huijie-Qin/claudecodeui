export type WebSocketLifecycleState = {
  unmounted: boolean;
  generation: number;
};

export function createWebSocketLifecycleState(): WebSocketLifecycleState {
  return {
    unmounted: false,
    generation: 0,
  };
}

export function prepareWebSocketConnectionAttempt(
  lifecycleRef: { current: WebSocketLifecycleState },
): number {
  lifecycleRef.current.unmounted = false;
  lifecycleRef.current.generation += 1;
  return lifecycleRef.current.generation;
}

export function markWebSocketLifecycleClosed(
  lifecycleRef: { current: WebSocketLifecycleState },
) {
  lifecycleRef.current.unmounted = true;
  lifecycleRef.current.generation += 1;
}

export function isCurrentWebSocketConnectionAttempt(
  lifecycleRef: { current: WebSocketLifecycleState },
  attemptGeneration: number,
): boolean {
  return !lifecycleRef.current.unmounted && lifecycleRef.current.generation === attemptGeneration;
}

export function shouldAttemptTenantWebSocketConnection(tenantId: number | null | undefined): boolean {
  return tenantId !== null && tenantId !== undefined;
}
