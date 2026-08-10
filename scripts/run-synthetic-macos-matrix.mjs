const debugPort = Number(process.env.MONEY_MOVES_MATRIX_DEBUG_PORT || '9224');
const passphrase = process.env.MONEY_MOVES_MATRIX_PASSPHRASE;

if (!passphrase || passphrase.length < 12) throw new Error('A disposable matrix passphrase of at least 12 characters is required.');

const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
const page = targets.find(target => target.type === 'page' && target.url === 'money-moves://app/index.html');
if (!page?.webSocketDebuggerUrl) throw new Error('The disposable Money Moves test instance is not available on the local debug endpoint.');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, {once:true});
  socket.addEventListener('error', () => reject(new Error('Could not connect to the disposable test instance.')), {once:true});
});
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const resolve = pending.get(message.id);
  if (resolve) { pending.delete(message.id); resolve(message); }
});

function evaluate(expression) {
  const id = nextId++;
  socket.send(JSON.stringify({id, method:'Runtime.evaluate', params:{expression, awaitPromise:true, returnByValue:true}}));
  return new Promise((resolve, reject) => {
    pending.set(id, message => {
      if (message.error || message.result?.exceptionDetails) reject(new Error('Synthetic UI evaluation failed.'));
      else resolve(message.result?.result?.value);
    });
  });
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const initial = await evaluate(`(() => ({setup:!document.getElementById('setupPanel').classList.contains('hidden'), unlock:!document.getElementById('unlockPanel').classList.contains('hidden')}))()`);
if (initial.setup) {
  await evaluate(`(() => {
    for (const id of ['newPass', 'confirmPass']) { const input = document.getElementById(id); input.value = ${JSON.stringify(passphrase)}; input.dispatchEvent(new Event('input', {bubbles:true})); }
    document.getElementById('createVault').click();
  })()`);
  await wait(600);
} else if (initial.unlock) {
  await evaluate(`(() => { const input = document.getElementById('unlockPass'); input.value = ${JSON.stringify(passphrase)}; input.dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('unlockVault').click(); })()`);
  await wait(600);
} else {
  throw new Error('The disposable instance did not present Create Vault or Unlock Vault.');
}

const workflows = await evaluate(`(() => {
  const click = selector => document.querySelector(selector).click();
  click('[data-screen="review"]');
  const review = document.getElementById('screen-review').classList.contains('active');
  click('[data-screen="devotionals"]');
  const devotionals = document.getElementById('screen-devotionals').classList.contains('active') && document.getElementById('devotionalReaderTitle').textContent.trim().length > 0;
  click('[data-screen="settings"]');
  const backup = Boolean(document.getElementById('exportBackup') && document.getElementById('restoreBackup'));
  document.getElementById('lockNow').click();
  return {review, devotionals, backup, locked:document.getElementById('lockLayer').classList.contains('show')};
})()`);
if (!workflows.review || !workflows.devotionals || !workflows.backup || !workflows.locked) throw new Error('Synthetic matrix workflow entry-point or lock check failed.');

await evaluate(`(() => { const input = document.getElementById('unlockPass'); input.value = ${JSON.stringify(passphrase)}; input.dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('unlockVault').click(); })()`);
await wait(600);
const unlocked = await evaluate(`(() => !document.getElementById('lockLayer').classList.contains('show'))()`);
socket.close();
if (!unlocked) throw new Error('Synthetic vault did not unlock after the lock check.');
process.stdout.write('Synthetic desktop matrix passed: fresh vault, V2B review entry point, Faith & Money, backup/restore entry points, lock, and unlock.\n');
