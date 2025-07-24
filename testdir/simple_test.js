
function hello() {
  console.log('world');
}

function goodbye() {
  hello();
  console.log('farewell');
}

function main() {
  hello();
  goodbye();
}

main();

