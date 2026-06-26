const fs = require('fs');
let c = fs.readFileSync('app/page.tsx', 'utf8');

// Show what we're working with
const idx = c.indexOf('c.important ?');
console.log('Found at:', idx);
console.log('Context:', JSON.stringify(c.substring(idx, idx + 50)));

c = c.replace("c.important ? '\ud575\uc2ec' : '\ucc38\uace0'", 'c.important ? T.impKey : T.impRef');
c = c.replace('\uc798 \uacb0\uc815 \uae30\uac00', 'placeholder');
// totalCriteria
c = c.replace('\uc598 \uacb0\uc815 \uae30\uc900', '{T.totalCriteria}');
c = c.replace('\ucd1d \uacb0\uc815 \uae30\uc900', '{T.totalCriteria}');
// countSuffix
c = c.replace(/\{droppedCriteria\.length\}\uac1c</g, '{droppedCriteria.length}{T.countSuffix}<');
c = c.replace(/\{droppedItems\.length\}\uac1c</g, '{droppedItems.length}{T.countSuffix}<');
// productsConsidered
c = c.replace('\uace0\ub824\ud55c \uc81c\ud488 \uc218', '{T.productsConsidered}');
// exploredCategories
c = c.replace('\ud0d0\uc0c9 \uce74\ud14c\uace0\ub9ac', '{T.exploredCategories}');

fs.writeFileSync('app/page.tsx', c, 'utf8');
console.log('Done');
