import './styles.css';

const retryButton = document.querySelector<HTMLButtonElement>('#retry');
const status = document.querySelector<HTMLElement>('#status');

function updateNetworkStatus(): void {
  if (!status) {
    return;
  }
  status.textContent = navigator.onLine
    ? '网络已恢复，点击重试重新连接。'
    : '当前设备处于离线状态，请检查网络连接。';
}

retryButton?.addEventListener('click', () => {
  if (retryButton) {
    retryButton.disabled = true;
    retryButton.textContent = '正在连接…';
  }
  window.cloudcliDesktop.retryConnection();
});
window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);
updateNetworkStatus();
