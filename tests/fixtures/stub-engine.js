// A stand-in for the Python engine, to test the process runner.
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const req = JSON.parse(input.split('\n')[0]);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  switch (req.mode) {
    case 'ok':
      out({ type: 'start' });
      process.stdout.write('this line is not json\n');
      out({ type: 'stage', key: 'market_report' });
      // split one event across two writes to test line buffering
      process.stdout.write('{"type":"result","rat');
      setTimeout(() => { process.stdout.write('ing":"Buy"}\n'); }, 20);
      break;
    case 'error':
      out({ type: 'error', message: 'boom', trace: 'tb' });
      process.exit(1);
      break;
    case 'crash':
      process.stderr.write('segfault-ish\n');
      process.exit(3);
      break;
    case 'hang':
      out({ type: 'start' });
      setInterval(() => {}, 1000);
      break;
    default:
      process.exit(2);
  }
});
