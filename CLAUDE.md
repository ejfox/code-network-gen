⏺ Those weird single-letter function names are from the prettify.js file! Looking at the CSV data, you can see
entries like:

prettify.js:ab,ab,function,[2-2]
prettify.js:T,T,function,[2-2]
prettify.js:X,X,function,[2-2]
prettify.js:W,W,function,[2-2]
prettify.js:k,k,function,[2-2]

This is because prettify.js appears to be a minified JavaScript library for syntax highlighting. When JavaScript
gets minified/uglified for production, all the original function names get shortened to single letters to
reduce file size:

- prettyPrintCodeBlock() becomes T()
- highlightSyntax() becomes X()
- parseTokens() becomes k()
- etc.

The code analysis tool that generated this demo network is faithfully capturing what it finds in the codebase -
including these minified function names. It's actually a good example of how the tool works across different
types of code (readable source files vs minified libraries).

You're seeing the real structure of your codebase, warts and all! The single-letter names are definitely weird
to look at, but they're an accurate representation of what's actually in that minified file.
