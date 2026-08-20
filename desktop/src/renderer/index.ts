import './styles.css';

const retryButton = document.querySelector<HTMLButtonElement>('#retry');
const openLogsButton = document.querySelector<HTMLButtonElement>('#open-logs');
const status = document.querySelector<HTMLElement>('#status');

function renderStatus(backendStatus: CloudCliDesktopBackendStatus): void {
  if (!status) {
    return;
  }
  if (backendStatus.state === 'error') {
    status.textContent = backendStatus.message;
  } else if (backendStatus.state === 'starting' || backendStatus.state === 'stopping') {
    status.textContent = backendStatus.message;
  } else if (backendStatus.state === 'ready') {
    status.textContent = '本地服务已启动，正在打开 CloudCLI…';
  } else {
    status.textContent = '本地服务尚未启动，点击重试。';
  }
}

retryButton?.addEventListener('click', () => {
  if (retryButton) {
    retryButton.disabled = true;
    retryButton.textContent = '正在启动…';
  }
  void window.cloudcliDesktop?.retryBackend()
    .then(renderStatus)
    .catch(() => {
      renderStatus({
        state: 'error',
        code: 'RETRY_FAILED',
        message: '无法重启本地服务，请查看日志后重试。',
      });
    })
    .finally(() => {
      if (retryButton) {
        retryButton.disabled = false;
        retryButton.textContent = '重试';
      }
    });
});

openLogsButton?.addEventListener('click', () => {
  void window.cloudcliDesktop?.openBackendLogs();
});

void window.cloudcliDesktop?.getBackendStatus()
  .then(renderStatus)
  .catch(() => {
    renderStatus({
      state: 'error',
      code: 'STATUS_UNAVAILABLE',
      message: '无法读取本地服务状态，请重试。',
    });
  });
