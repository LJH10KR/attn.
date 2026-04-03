/**
 * 사용자 입력 등을 HTML 컨텍스트에 넣기 전에 이스케이프할 때 사용.
 * (기본적으로 React 텍스트 노드는 자동 이스케이프되므로, DOM API·dangerouslySetInnerHTML 등에만 필요)
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
