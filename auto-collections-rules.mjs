// Auto collections: keyword rules that sort books into themed collections.
// Pure code (no database) so the browser, the Worker and tests share it.
//
// Each collection has three keyword lists:
//  labels  - matched against the book's genres, tags and shelves
//            (EPUB subjects, Goodreads shelves, your own tags)
//  text    - matched against the title and synopsis; keep these specific,
//            because synopses mention lots of things in passing
//  exclude - if any of these match labels or text, the rule does not apply
// A keyword ending in * matches word beginnings: "witch*" matches witch,
// witches, witchcraft and witchy. A keyword starting with = must be a whole
// tag or shelf on its own: "=dark" matches the shelf "dark" but not
// "dark academia" or Open Library's "Man-woman relationships" for "=relationships". Matching ignores case, accents and
// punctuation, so "Fae-Fantasy", "fae_fantasy" and "fae fantasy" are equal.

export const KEYWORD_LIMIT=80;
export const KEYWORD_LENGTH=60;

export function normalizeText(value){
 return String(value??'').toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g,'')
  .replace(/['’`]/g,'')
  .replace(/[^a-z0-9]+/g,' ')
  .trim();
}

// Accepts an array or a comma/newline separated string. Returns clean,
// de-duplicated keywords as typed (lowercased), keeping a trailing *.
export function cleanKeywords(value){
 const list=Array.isArray(value)?value:String(value??'').split(/[,\n]/);
 const out=[];
 for(const raw of list){
  const text=String(raw??'').trim().toLowerCase();
  if(!text)continue;
  if(text.length>KEYWORD_LENGTH)throw Error('Collection keyword is too long: '+text.slice(0,30)+'…');
  const wildcard=text.endsWith('*'),exact=text.startsWith('=');
  if(!normalizeText(text.slice(exact?1:0,wildcard?-1:undefined)))continue;
  if(!out.includes(text))out.push(text);
 }
 if(out.length>KEYWORD_LIMIT)throw Error('Collection has too many keywords (limit '+KEYWORD_LIMIT+')');
 return out;
}

const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Labels are joined with newlines so one tag's last word and the next tag's
// first word can never combine into a phrase ("dark" + "fantasy").
function keywordPattern(keyword){
 const wildcard=keyword.endsWith('*'),exact=keyword.startsWith('=');
 const base=normalizeText(keyword.slice(exact?1:0,wildcard?-1:undefined));
 if(!base)return null;
 const end=wildcard?'[a-z0-9]*':'';
 return exact?'(?:^|\\n)'+escape(base)+end+'(?=\\n|$)':
  '(?:^|[ \\n])'+escape(base)+end+'(?=[ \\n]|$)';
}
function compileList(keywords){
 const items=[];
 for(const keyword of keywords||[]){
  const pattern=keywordPattern(keyword);
  if(pattern)items.push({keyword,re:new RegExp(pattern)});
 }
 // One combined test first; only find the specific keyword on a hit.
 const any=items.length?new RegExp(items.map(i=>i.re.source).join('|')):null;
 return {
  test:text=>!!any&&any.test(text),
  first:text=>{
   if(!any||!any.test(text))return null;
   return items.find(i=>i.re.test(text))?.keyword||null;
  }
 };
}
export function compileRule(collection){
 return {
  id:collection.id,
  labels:compileList(collection.label_keywords),
  text:compileList(collection.text_keywords),
  exclude:compileList(collection.exclude_keywords)
 };
}

// book: {title, synopsis, labels:[...]}  → normalized fields to test once.
export function bookFields(book){
 return {
  labels:(book.labels||[]).map(normalizeText).filter(Boolean).join('\n'),
  text:normalizeText(book.title)+'\n'+normalizeText(book.synopsis)
 };
}

// Returns a short human reason ("tag: fae", "synopsis: faerie") or null.
export function matchBook(rule,fields){
 if(rule.exclude.test(fields.labels)||rule.exclude.test(fields.text))return null;
 const label=rule.labels.first(fields.labels);
 if(label)return 'tag or shelf: '+label;
 const text=rule.text.first(fields.text);
 if(text)return 'title or synopsis: '+text;
 return null;
}

const C=(key,name,category,description,labels,text=[],exclude=[])=>
 ({key,name,category,description,label_keywords:labels,text_keywords:text,exclude_keywords:exclude});

const MAGIC='Magic & creatures';
const WORLDS='Worlds & time';
const THEMES='Themes & tropes';
const QUEER='Queer & representation';
const ORIGIN='Origin & translation';
const AGES='Age range';
const NONFICTION='Non-fiction';

// Starting set. Everything here is editable or deletable in the app, and
// "Restore missing defaults" brings back any default you deleted.
export const DEFAULT_COLLECTIONS=[
 C('witches','Witches',MAGIC,'Witches, covens and witchcraft.',
  ['witch*','coven*','warlock*','hedge magic'],
  ['witch','witches','witchcraft','witchy','coven','covens','warlock*']),
 C('fae','Fae & Faerie',MAGIC,'The fae, faerie courts, the fey and changelings.',
  ['fae','faerie*','faery','fey','fairies','darkfairies','dark fairies','fairy court*','fairy realm*','high fae','seelie','unseelie','changeling*','sidhe'],
  ['fae','faerie*','faery','the fey','seelie','unseelie','fairies','fairy court*','fairy realm','fairy king','fairy queen','fairy prince*','changeling*']),
 C('mermaids','Mermaids & Sirens',MAGIC,'Mermaids, merfolk, sirens and selkies.',
  ['mermaid*','merman','mermen','merfolk','siren*','selkie*'],
  ['mermaid*','merman','mermen','merfolk','sirens','siren song','selkie*']),
 C('vampires','Vampires',MAGIC,'Vampires and blood drinkers.',
  ['vampir*','vampyr*'],['vampir*','vampyr*']),
 C('shifters','Werewolves & Shifters',MAGIC,'Werewolves, shapeshifters and lycans.',
  ['werewol*','shifter*','shapeshift*','shape shift*','lycan*'],
  ['werewol*','shifter*','shapeshift*','lycan*']),
 C('dragons','Dragons',MAGIC,'Dragons, wyverns and dragon riders.',
  ['dragon*','wyvern*'],['dragons','dragon rider*','wyvern*']),
 C('ghosts','Ghosts & Hauntings',MAGIC,'Ghosts, spirits and haunted places.',
  ['ghost*','haunt*'],['ghost','ghosts','haunted','haunting']),
 C('mythology','Gods & Mythology',MAGIC,'Gods, goddesses and myth.',
  ['mytholog*','myths','myth and monsters','greek myth*','norse*','=gods','goddess*','deities'],
  ['mythology','greek gods','norse gods','the gods','goddess of*']),
 C('cultivation','Cultivation & Martial Arts',MAGIC,'Cultivation, sects, wuxia and xianxia.',
  ['cultivation','cultivat*','xianxia','wuxia','xuanhuan','martial art*','murim'],
  ['cultivation','cultivator*','martial arts','murim','immortal sect','sect elder*','the jianghu']),
 C('litrpg','LitRPG & System',MAGIC,'Game systems, levels, dungeons and progression fantasy.',
  // Not plain "system": it would catch every "magic system" tag.
  ['litrpg','lit rpg','gamelit','progression fantasy','dungeon core','system fantasy','system apocalypse','game system','vrmmo*','game world'],
  ['litrpg','status window','the system','level up','vrmmo*','dungeon core']),

 C('angels-demons','Angels & Demons',MAGIC,'Angels, demons and holy or unholy horror.',
  ['angel*','dark angels','angelic horror','demon*','biblical horror*','creepycatholicism'],['fallen angel*','demon*','archangel*']),
 C('necromancers','Necromancers',MAGIC,'Necromancy and raising the dead.',
  ['necromanc*'],['necromanc*']),
 C('monsters','Monsters',MAGIC,'Monsters, creatures and monster romance.',
  ['monster*','myth and monsters','creature*','kaiju'],['monster romance']),
 C('superheroes','Superheroes & Magical Girls',MAGIC,'Capes, villains and magical girls.',
  ['superhero*','super hero*','batman','magical girl*','supervillain*'],['superhero*','supervillain*','magical girl*']),
 C('dark-fantasy','Dark & Grimdark',WORLDS,'Dark, brutal and morally grey stories.',
  ['grimdark','grim dark','dark fantasy','gothic fantasy','=dark'],['grimdark','dark fantasy']),
 C('cyberpunk','Cyberpunk, AI & Robots',WORLDS,'Cyberpunk, artificial intelligence, robots and mecha.',
  ['cyberpunk','=ai','artificial intelligence','robot*','android*','mecha','wetware','biopunk','steampunk'],
  ['cyberpunk','artificial intelligence','sentient ai','android*','robot*']),
 C('aliens','Aliens & First Contact',WORLDS,'Aliens, first contact and life beyond Earth.',
  ['alien*','first contact','space opera'],['aliens','alien invasion','first contact']),
 C('alt-history','Alternate History & What-ifs',WORLDS,'History that went differently.',
  ['alternate history','alternative history','what if'],['alternate history']),
 C('time-travel','Time Travel',WORLDS,'Time travel, time loops and time slips.',
  ['time travel*','time loop*','time slip*','timeslip'],
  ['time travel*','time loop','time machine','travels back in time','sent back in time','back in time']),
 C('isekai','Isekai & World Travel',WORLDS,'Transported, summoned or reincarnated into another world or dimension.',
  ['isekai','transmigrat*','portal fantasy','portal*','reincarnat*','another world','other world*','otherworld*','parallel world*','dimension travel*','world travel*','summoned hero'],
  ['isekai','transmigrat*','another world','other world','parallel world*','parallel universe*','alternate world','alternate dimension','another dimension','different world','through a portal','summoned to*','transported to*','reincarnated']),
 C('regression','Regression & Second Chances',WORLDS,'Regressors, rebirth and do-overs.',
  ['regression','regressor*','regress*','rebirth','reborn','returner','do over'],
  // Not "second chance" on its own: on Goodreads that's usually the romance trope.
  ['regress*','reborn','rebirth','second life','second chance at life','returned to the past','returns to the past','back to the past','woke up in the past']),
 C('apocalypse','Apocalypse & Dystopia',WORLDS,'Post-apocalyptic, zombies and dystopian worlds.',
  ['post apocalyptic','postapocalyptic','apocalyp*','dystopia*','zombie*','world-s-end','worlds end','end of the world'],
  ['apocalypse','post apocalyptic','zombie*','dystopian']),
 C('survival','Survival',WORLDS,'Survival stories, death games and being stranded.',
  ['survival*','death game*','stranded','battle royale'],
  ['fight to survive','struggle to survive','fight for survival','survival game','death game','battle royale','stranded on']),
 C('academia','Dark Academia & Magic Schools',WORLDS,'Magic schools, academies and dark academia.',
  ['dark academia','magic school*','magic academy','magical academy','academy','boarding school*','school of magic'],
  ['dark academia','magic school','school of magic','school for magic','magic academy','magical academy','academy of magic']),
 C('gothic-horror','Gothic & Horror',WORLDS,'Gothic atmosphere and horror.',
  ['gothic*','horror*','deepseahorror','hauntedhouse','found footage','final girls','creepy*'],['gothic']),

 C('weird-unique','Weird, Unique & Subversive',THEMES,'Strange, one-of-a-kind and trope-subverting books.',
  ['unique books','=unique','craziest books i ve seen','subversion','=weird','magical realism','bizarro*']),
 C('=funny','Funny & Feel-good',THEMES,'Funny, joyful and cute reads.',
  ['=funny','=humor','=humour','=comedy','=joy','=cute','bubblegum']),
 C('slow-burn','Slow Burn & Forbidden Love',THEMES,'Slow burn, forbidden love, class differences and love triangles.',
  ['slow burn','forbidden love','class difference','love triangle*','fake relationship','fake dating','instalove avoid'],
  ['slow burn','forbidden love']),
 C('gentle-heroes','Soft & Gentle Heroes',THEMES,'Kind, gentle or beta heroes, and heroes unused to kindness.',
  ['beta hero','gentle hero','cinnamon roll','hero unused to kindness','feminist hero','bodyguard']),
 C('fierce-heroines','Fierce Heroines',THEMES,'Female leads, feral girls, final girls and badass women.',
  ['female protagonist','female lead','feral girls','final girls','=badass','feminist hero','girlhood']),
 C('gender-bender','Gender Bender & Disguise',THEMES,'Disguised as a boy, hidden or mistaken identity, and gender bender.',
  ['gender bender','disguised as boy','disguised-as-boy','hidden identity','mistaken identity','crossdress*'],
  ['disguised as a boy','disguises herself as a boy','gender bender']),
 C('romantasy','Romantasy',THEMES,'Romance-driven fantasy.',
  ['romantasy','fantasy romance','romantic fantasy','paranormal romance'],['romantasy']),
 C('enemies-lovers','Enemies to Lovers',THEMES,'Enemies or rivals who fall in love.',
  ['enemies to lover*','rivals to lover*','rivals','love hate'],['enemies to lovers','rivals to lovers']),
 C('villainess','Villainess & Otome',THEMES,'Villainesses, otome games and villains as leads.',
  ['villainess*','otome*','villain*'],['villainess','otome game']),
 C('retellings','Retellings & Fairy Tales',THEMES,'Myth, legend and fairy-tale retellings.',
  ['retelling*','fairy tale*','fairytale*','folklore','folk tale*'],
  ['retelling','reimagining','fairy tale retelling','retold']),
 C('royals','Royals & Court Intrigue',THEMES,'Princes, empresses and palace politics.',
  // Not "royal*": Royal Road is a web-novel site, so it shows up as a shelf.
  ['royalty','royals','royal court','royal romance','court intrigue','court politics','palace*','princess*','prince*','empress*','emperor*'],
  ['court intrigue','the crown prince','crown princess','the empress','the emperor','palace intrigue']),
 C('assassins','Assassins & Thieves',THEMES,'Assassins, thieves and heists.',
  ['assassin*','thief','thieves','heist*'],['assassin*','heist','thief','thieves']),
 C('cozy','Cozy Fantasy',THEMES,'Low stakes, warm and comforting stories.',
  ['cozy fantasy','cosy fantasy','cozy fantasy*','cozy cute','cooking fantasy'],['cozy fantasy','cosy fantasy']),

 C('short-stories','Short Stories & Novellas',THEMES,'Short stories, novellas, anthologies and essays.',
  ['short stor*','novella*','anthology','anthologies','essays']),
 C('=graphic','Graphic Novels & Manga',THEMES,'Comics, graphic novels and manga.',
  ['graphic novel*','graphic novels comics','=graphic','comic*','manga','manhwa','webtoon*','artbook']),
 C('gay','Gay (MLM)',QUEER,'Gay and MLM stories, BL and danmei.',
  ['gay*','mlm','m/m','mm romance','bl','boys love','boy love','danmei','yaoi','shounen ai'],
  ['gay','mlm','boys love','danmei']),
 C('sapphic','Sapphic (WLW)',QUEER,'Sapphic, lesbian and WLW stories, GL and yuri.',
  ['sapphic','lesbian*','wlw','f/f','ff romance','gl','girls love','girl love','yuri','baihe','shoujo ai'],
  ['sapphic','lesbian','lesbians','wlw','girls love','yuri','baihe']),
 C('queer','Queer & LGBTQ+',QUEER,'Everything queer: gay, sapphic, trans, bi, ace and more.',
  ['lgbt*','queer*','trans','transgender','nonbinary','non binary','bisexual','asexual','gay*','lesbian*','sapphic','mlm','wlw','danmei','yuri','bl','gl'],
  ['lgbtq*','queer','transgender','nonbinary','non binary','bisexual','asexual','gay','lesbian','sapphic']),

 C('translated','Translated Literature',ORIGIN,'Books translated into English, including translated web novels.',
  ['translat*','in translation','danmei','wuxia','xianxia','xuanhuan','baihe','light novel*','korean lit*','japanese lit*','chinese lit*','korean fiction','japanese fiction','chinese fiction'],
  ['translated from*','translated by','in translation','english translation']),
 C('korean','Korean',ORIGIN,'Korean books and authors (from tags, shelves and translation notes).',
  ['korea*','k lit','manhwa','kdrama','k drama'],['translated from the korean','korean web novel']),
 C('chinese','Chinese',ORIGIN,'Chinese books and authors, including danmei and cultivation novels.',
  ['chinese*','china','danmei','wuxia','xianxia','xuanhuan','baihe','c novel*','cnovel*'],
  ['translated from the chinese','chinese web novel']),
 C('japanese','Japanese',ORIGIN,'Japanese books and authors, including light novels.',
  ['japan*','light novel*'],['translated from the japanese','japanese light novel']),
 C('british-irish','British & Irish',ORIGIN,'British, Irish, Scottish and Welsh books and authors.',
  ['british*','irish*','scottish*','welsh*','uk author*']),
 C('south-asian','Indian & South Asian',ORIGIN,'Indian, Pakistani, Bangladeshi and Sri Lankan books and authors.',
  ['india*','south asian*','desi','pakistan*','bangladesh*','sri lanka*'],['translated from the hindi','translated from the urdu','translated from the bengali']),
 C('african','African',ORIGIN,'African books and authors.',
  ['africa*','nigeria*','ghana*','kenya*','south african*','west african*'],['west african mythology']),
 C('latin-american','Latin American & Spanish',ORIGIN,'Latin American and Spanish books and authors.',
  ['latin american*','latinx','latine','cuba*','mexic*','argentin*','colombia*','brazil*','chile*','peru*','spanish lit*','spain'],
  ['translated from the spanish','translated from the portuguese']),
 C('european','European in Translation',ORIGIN,'French, German, Italian, Russian, Nordic and other European books.',
  ['french lit*','french fiction','german lit*','italian lit*','russian*','polish*','ukrain*','scandinavia*','nordic*','swedish*','norwegian*','danish*','finnish*','icelandic*'],
  ['translated from the french','translated from the german','translated from the italian','translated from the russian','translated from the polish','translated from the swedish','translated from the norwegian','translated from the danish','translated from the finnish']),
 C('middle-eastern','Middle Eastern',ORIGIN,'Arab, Persian, Turkish and other Middle Eastern books and authors.',
  ['middle east*','arab*','persia*','iran*','turkish*','turkey','palestin*','lebanese','egypt*'],
  ['translated from the arabic','translated from the persian','translated from the farsi','translated from the turkish']),

 C('poc-authors','Authors of Color',ORIGIN,'Books you have shelved as by non-white authors or authors of color.',
  ['non white authors','non-white-authors','authors of color','poc authors','own voices','ownvoices','black authors','asian authors']),

 C('microhistory','Microhistory & History',NONFICTION,'Microhistories and history told through one thing or people.',
  ['microhistory','history told by people','bigpicturepast','big picture past','chemistryhistory']),
 C('mind-brain','Mind & Brain',NONFICTION,'Psychology, cognition, the brain and the unconscious.',
  ['=brain','unconscious mind','newtheoriesofcognition','=memory','=senses','psychology','neuroscience','adhd','=thinking','decision making']),
 C('culture-society','Culture & Society',NONFICTION,'Culture, sociology, media and the internet.',
  ['=culture','sociology*','cultural evolution','internet culture','=internet','pop culture*','media ecology','academic culture society media','propaganda','anthro*']),
 C('=science','Science',NONFICTION,'Science, popular science and the science industry.',
  ['=science','cool science','pop science','science industry','bad science','pharma','statistics','=data','chemistry*']),
 C('business-work','Business & Work',NONFICTION,'Business, marketing, design, product and negotiation.',
  ['=business','marketing*','customer design','ux research','=product','=work','negotiate','interviewing','consulting','=hired']),
 C('self-improvement','Self-improvement & Life Advice',NONFICTION,'Books to live by, life advice and self-improvement.',
  ['self improvement','life advice','books to live by','=communicating','=relationships','=joy','=distraction','procastination','procrastination']),
 C('big-ideas','Big Ideas & Learning',NONFICTION,'Books to learn from: big-picture, interdisciplinary and idea books.',
  ['books-to-learn-from','you-re-gonna-learn','big picture','idea insights','interdiscipline','critical thinking','problem solving','=learning','=knowledge','everyday knowledge','=analysis']),
 C('true-stories','True Stories',NONFICTION,'Real-life stories, memoirs and biographies.',
  ['crazyreallife','based on real life','memoir*','biograph*','autobiograph*']),
 C('politics-world','Politics & World Affairs',NONFICTION,'Politics, war, propaganda, forecasting and global issues.',
  ['=war','peace and politics','propaganda','ir cyber','social engineering','forecasting','effective altruism','global health poverty','politic*']),
 C('=health','Health & Medicine',NONFICTION,'Health, medicine, pharma and the body.',
  ['dermatology','medical mindset','pharma','global health poverty','=health','=medicine','=medical']),
 C('art-design','Art & Design',NONFICTION,'Art, design, photography, fashion and film.',
  ['=art','why art matters','photography','=fashion','artbook','=film','=music','=design']),
 C('writing-language','Writing & Language',NONFICTION,'Writing, words, linguistics and rhetoric.',
  ['=writing','=language','linguistics','=words','secret language','rhetoric','=creativity']),

 C('childrens','Children’s',AGES,'Children’s books, picture books and middle grade.',
  ['children*','childrens*','kids','juvenile*','middle grade','picture book*','chapter book*','early reader*','grade school']),
 C('young-adult','Young Adult',AGES,'Young adult and teen books.',
  ['young adult*','ya','teen','teens','teen fiction','gothic ya'])
];
