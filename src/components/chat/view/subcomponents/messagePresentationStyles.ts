export function messageRowClassName(type: string, grouped = false) {
  return `chat-message ${type} ${grouped ? 'grouped' : ''} ${type === 'user' ? 'flex justify-end px-3 sm:px-0' : 'px-3 sm:px-0'}`;
}
