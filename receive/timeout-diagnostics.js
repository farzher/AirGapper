const diagnostics = document.getElementById("transport-diagnostics");
const textContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");

if (diagnostics && textContent?.get && textContent?.set) {
  try {
    Object.defineProperty(diagnostics, "textContent", {
      configurable: true,
      get() {
        return textContent.get.call(this);
      },
      set(value) {
        let text = String(value ?? "").replace(/\nStale timeouts[^\n]*/g, "");
        const state = window.airgapperTrackedTimeoutState?.();
        if (state) {
          const pressure = Math.round((Number(state.pressure) || 0) * 100);
          text += `\nStale timeouts ${Number(state.count) || 0} · decode ${Number(state.decode) || 0} · preflight ${Number(state.preflight) || 0} · pressure ${pressure}%`;
        }
        textContent.set.call(this, text);
      }
    });
  } catch {}
}
