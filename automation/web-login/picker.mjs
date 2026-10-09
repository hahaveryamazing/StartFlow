// Fixed browser-side picker: no input/change hooks, no input values, cookies or page dumps.
export function installPicker() {
  let field = null;
  const names = {
    username: '账号输入框',
    password: '密码输入框',
    submit: '登录按钮',
    success: '登录成功标识',
    identity: '账号身份标识',
    challenge: '人工验证标识',
    failure: '登录失败标识',
  };
  let host, root, title, box;
  const render = () => {
    if (!document.documentElement) return;
    if (!host?.isConnected) {
      host = document.createElement('div');
      host.id = '__startflow_recorder_overlay';
      Object.assign(host.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483647',
        pointerEvents: 'none',
      });
      root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent =
        ':host{pointer-events:none} .title{position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:12px 22px;background:#111827;color:#f8fafc;border:1px solid #3b82f6;border-radius:12px;font:14px "Segoe UI",sans-serif;box-shadow:0 8px 28px #0004} .box{position:fixed;border:2px solid #3b82f6;border-radius:5px;background:#3b82f61a;display:none;box-sizing:border-box}';
      title = document.createElement('div');
      title.className = 'title';
      box = document.createElement('div');
      box.className = 'box';
      root.append(style, title, box);
      document.documentElement.append(host);
    }
    title.textContent = field
      ? `StartFlow · 点击选择${names[field]} · Esc 暂停`
      : 'StartFlow · 录制浏览器 · 回到应用选择下一步，或按提示手动登录';
  };
  Object.defineProperty(window, '__sfRecordArm', {
    value: (value) => {
      field = Object.hasOwn(names, value) ? value : null;
      render();
      if (box) box.style.display = 'none';
    },
  });
  document.addEventListener('DOMContentLoaded', render, { once: true });
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!field || !e.isTrusted) return;
      render();
      const target = e.target.closest?.('button,input,label') ?? e.target;
      const r = target.getBoundingClientRect();
      Object.assign(box.style, {
        display: 'block',
        left: r.left + 'px',
        top: r.top + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
      });
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      if (!field || !e.isTrusted) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Only coordinates cross the binding. DOM metadata is derived/validated in the controlled worker.
      void window.__sfRecordClick({ x: e.clientX, y: e.clientY });
    },
    true,
  );
  document.addEventListener(
    'submit',
    (e) => {
      if (field) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        field = null;
        render();
        if (box) box.style.display = 'none';
      }
    },
    true,
  );
}
