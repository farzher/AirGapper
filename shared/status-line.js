function statusLine(el) {
  return {
    setStatus(message) {
      el.classList.remove("error");
      el.textContent = message;
    },
    showError(message) {
      el.classList.add("error");
      el.textContent = `✗ ${message}`;
    }
  };
}
export {
  statusLine
};
