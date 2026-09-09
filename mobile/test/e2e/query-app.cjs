// An outer terminal query source. Queries are triggered explicitly so the
// tests distinguish live requests from historical requests that timed out.
process.stdin.setRawMode(true);
process.stdout.write('QUERY-APP-READY\r\n');
let input = '', replies = 0;
process.stdin.on('data', chunk => {
  input += chunk.toString();
  input = input.replace(/\x1b\[>[0-9;]+c/g, () => {
    process.stdout.write(`\r\nQUERY-REPLIES-${++replies}\r\n`);
    return '';
  });
  input = input.replace(/marker/g, () => {
    process.stdout.write(`\r\nMARKER-ACK-REPLIES-${replies}\r\n`);
    return '';
  });
  input = input.replace(/queryagain/g, () => {
    process.stdout.write('\r\nNEW-QUERY\x1b[>c');
    return '';
  });
  if (input.length > 4096) input = input.slice(-100);
});
