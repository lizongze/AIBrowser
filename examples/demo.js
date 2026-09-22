const button = document.getElementById('btn');
const counter = document.getElementById('count');
let n = 0;
button.addEventListener('click', () => {
  n += 1;
  counter.textContent = String(n);
  console.log('点击次数：', n);
});
console.log('demo 页面已就绪', location.href);
window.__PVS_DEMO__ = { ready: true, cards: document.querySelectorAll('.card').length };
