/**
 * js/plugins/matrix-chat/src/ui/emoji-browser.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Full emoji picker (search + category tabs) opened as an escape hatch from
 * the quick-react menu in room-view.js — see the "+" button in
 * openReactionPicker() there. Pulled into its own module rather than staying
 * inline for the same reason createFullscreenViewer lives in its own file:
 * it's a self-contained widget with its own DOM, its own state (search
 * query, active category), and its own outside-click/Escape handling, so it
 * doesn't need to know anything about rooms, events, or reactions — it just
 * hands back whichever emoji the user picked.
 *
 * Usage (mirrors createFullscreenViewer's shape):
 *   const emojiBrowser = createEmojiBrowser(mountEl);
 *   emojiBrowser.open(x, y, (emoji) => toggleReaction(eventId, emoji));
 *   emojiBrowser.close();
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Deliberately a hand-picked subset rather than the full ~3,700-emoji
// Unicode set — this is a chat reaction picker, not a full IME. Breadth
// within each category matters more than exhaustiveness, and every entry
// needs real keywords for search to be worth having at all, so a curated
// ~250-emoji list that's actually searchable beats a dumped complete set
// that mostly isn't.
const EMOJI_CATEGORIES = [
  {
    id: 'smileys',
    label: 'Smileys & People',
    icon: '😀',
    emojis: [
      { char: '😀', name: 'grinning face', keywords: ['smile', 'happy', 'grin'] },
      { char: '😃', name: 'grinning face with big eyes', keywords: ['smile', 'happy', 'joy'] },
      { char: '😄', name: 'grinning face with smiling eyes', keywords: ['smile', 'happy', 'laugh'] },
      { char: '😁', name: 'beaming face with smiling eyes', keywords: ['grin', 'smile', 'happy'] },
      { char: '😆', name: 'grinning squinting face', keywords: ['laugh', 'happy', 'haha'] },
      { char: '😅', name: 'grinning face with sweat', keywords: ['laugh', 'nervous', 'relief'] },
      { char: '🤣', name: 'rolling on the floor laughing', keywords: ['lol', 'laugh', 'rofl'] },
      { char: '😂', name: 'face with tears of joy', keywords: ['laugh', 'cry', 'lol'] },
      { char: '🙂', name: 'slightly smiling face', keywords: ['smile', 'ok'] },
      { char: '🙃', name: 'upside-down face', keywords: ['silly', 'sarcasm'] },
      { char: '😉', name: 'winking face', keywords: ['wink', 'flirt'] },
      { char: '😊', name: 'smiling face with smiling eyes', keywords: ['smile', 'happy', 'blush'] },
      { char: '😇', name: 'smiling face with halo', keywords: ['angel', 'innocent'] },
      { char: '🥰', name: 'smiling face with hearts', keywords: ['love', 'crush', 'adore'] },
      { char: '😍', name: 'smiling face with heart-eyes', keywords: ['love', 'crush', 'heart'] },
      { char: '🤩', name: 'star-struck', keywords: ['starstruck', 'excited', 'wow'] },
      { char: '😘', name: 'face blowing a kiss', keywords: ['kiss', 'love'] },
      { char: '😗', name: 'kissing face', keywords: ['kiss'] },
      { char: '😋', name: 'face savoring food', keywords: ['yum', 'tasty', 'delicious'] },
      { char: '😛', name: 'face with tongue', keywords: ['tongue', 'silly'] },
      { char: '😜', name: 'winking face with tongue', keywords: ['silly', 'joke'] },
      { char: '🤪', name: 'zany face', keywords: ['crazy', 'wild', 'silly'] },
      { char: '😝', name: 'squinting face with tongue', keywords: ['silly', 'joke'] },
      { char: '🤑', name: 'money-mouth face', keywords: ['money', 'rich'] },
      { char: '🤗', name: 'hugging face', keywords: ['hug', 'thanks'] },
      { char: '🤭', name: 'face with hand over mouth', keywords: ['oops', 'giggle'] },
      { char: '🤫', name: 'shushing face', keywords: ['quiet', 'secret', 'shh'] },
      { char: '🤔', name: 'thinking face', keywords: ['think', 'hmm', 'consider'] },
      { char: '🤨', name: 'face with raised eyebrow', keywords: ['skeptical', 'suspicious'] },
      { char: '😐', name: 'neutral face', keywords: ['meh', 'neutral'] },
      { char: '😑', name: 'expressionless face', keywords: ['blank', 'meh'] },
      { char: '😶', name: 'face without mouth', keywords: ['silent', 'speechless'] },
      { char: '🙄', name: 'face with rolling eyes', keywords: ['eyeroll', 'annoyed', 'whatever'] },
      { char: '😏', name: 'smirking face', keywords: ['smirk', 'sly'] },
      { char: '😣', name: 'persevering face', keywords: ['struggle', 'frustrated'] },
      { char: '😥', name: 'sad but relieved face', keywords: ['sad', 'relieved', 'phew'] },
      { char: '😮', name: 'face with open mouth', keywords: ['wow', 'surprised', 'shock'] },
      { char: '🤐', name: 'zipper-mouth face', keywords: ['secret', 'silent'] },
      { char: '😯', name: 'hushed face', keywords: ['surprised', 'quiet'] },
      { char: '😪', name: 'sleepy face', keywords: ['tired', 'sleepy'] },
      { char: '😫', name: 'tired face', keywords: ['exhausted', 'tired'] },
      { char: '🥱', name: 'yawning face', keywords: ['tired', 'bored', 'yawn'] },
      { char: '😴', name: 'sleeping face', keywords: ['sleep', 'zzz'] },
      { char: '😌', name: 'relieved face', keywords: ['relief', 'calm'] },
      { char: '😷', name: 'face with medical mask', keywords: ['sick', 'mask'] },
      { char: '🤒', name: 'face with thermometer', keywords: ['sick', 'fever'] },
      { char: '🤕', name: 'face with head-bandage', keywords: ['hurt', 'injured'] },
      { char: '🤢', name: 'nauseated face', keywords: ['sick', 'gross', 'ill'] },
      { char: '🤮', name: 'face vomiting', keywords: ['sick', 'gross', 'vomit'] },
      { char: '🤧', name: 'sneezing face', keywords: ['sick', 'sneeze'] },
      { char: '🥵', name: 'hot face', keywords: ['hot', 'sweating'] },
      { char: '🥶', name: 'cold face', keywords: ['cold', 'freezing'] },
      { char: '🥴', name: 'woozy face', keywords: ['dizzy', 'drunk'] },
      { char: '😵', name: 'dizzy face', keywords: ['dizzy', 'confused'] },
      { char: '🤯', name: 'exploding head', keywords: ['mindblown', 'shocked'] },
      { char: '🤠', name: 'cowboy hat face', keywords: ['cowboy', 'yeehaw'] },
      { char: '🥳', name: 'partying face', keywords: ['party', 'celebrate'] },
      { char: '😎', name: 'smiling face with sunglasses', keywords: ['cool', 'sunglasses'] },
      { char: '🤓', name: 'nerd face', keywords: ['nerd', 'geek'] },
      { char: '🧐', name: 'face with monocle', keywords: ['inspect', 'curious'] },
      { char: '😕', name: 'confused face', keywords: ['confused', 'unsure'] },
      { char: '😟', name: 'worried face', keywords: ['worried', 'concerned'] },
      { char: '🙁', name: 'slightly frowning face', keywords: ['sad', 'frown'] },
      { char: '☹️', name: 'frowning face', keywords: ['sad', 'frown'] },
      { char: '😮\u200d💨', name: 'face exhaling', keywords: ['sigh', 'relief'] },
      { char: '😨', name: 'fearful face', keywords: ['scared', 'fear'] },
      { char: '😰', name: 'anxious face with sweat', keywords: ['nervous', 'anxious'] },
      { char: '😢', name: 'crying face', keywords: ['sad', 'cry', 'tear'] },
      { char: '😭', name: 'loudly crying face', keywords: ['sad', 'sob', 'cry'] },
      { char: '😱', name: 'face screaming in fear', keywords: ['scared', 'shocked', 'scream'] },
      { char: '😖', name: 'confounded face', keywords: ['frustrated', 'confused'] },
      { char: '😞', name: 'disappointed face', keywords: ['sad', 'disappointed'] },
      { char: '😓', name: 'downcast face with sweat', keywords: ['sad', 'sweat', 'tired'] },
      { char: '😩', name: 'weary face', keywords: ['tired', 'weary'] },
      { char: '😤', name: 'face with steam from nose', keywords: ['angry', 'frustrated', 'triumph'] },
      { char: '😡', name: 'pouting face', keywords: ['angry', 'mad', 'rage'] },
      { char: '😠', name: 'angry face', keywords: ['angry', 'mad'] },
      { char: '🤬', name: 'face with symbols on mouth', keywords: ['swearing', 'angry', 'cursing'] },
      { char: '😈', name: 'smiling face with horns', keywords: ['devil', 'evil', 'mischief'] },
      { char: '👿', name: 'angry face with horns', keywords: ['devil', 'angry'] },
      { char: '💀', name: 'skull', keywords: ['dead', 'skull', 'death'] },
      { char: '💩', name: 'pile of poo', keywords: ['poop', 'crap'] },
      { char: '🤡', name: 'clown face', keywords: ['clown', 'joke'] },
      { char: '👹', name: 'ogre', keywords: ['monster'] },
      { char: '👻', name: 'ghost', keywords: ['ghost', 'boo', 'spooky'] },
      { char: '👽', name: 'alien', keywords: ['alien', 'ufo'] },
      { char: '🤖', name: 'robot', keywords: ['robot', 'bot', 'ai'] },
      { char: '😺', name: 'grinning cat', keywords: ['cat', 'happy'] },
      { char: '😹', name: 'cat with tears of joy', keywords: ['cat', 'laugh'] },
      { char: '😻', name: 'smiling cat with heart-eyes', keywords: ['cat', 'love'] },
      { char: '👋', name: 'waving hand', keywords: ['wave', 'hello', 'bye'] },
      { char: '🤚', name: 'raised back of hand', keywords: ['hand', 'stop'] },
      { char: '🖐️', name: 'hand with fingers splayed', keywords: ['hand', 'stop', 'high five'] },
      { char: '✋', name: 'raised hand', keywords: ['stop', 'high five'] },
      { char: '👌', name: 'ok hand', keywords: ['ok', 'perfect'] },
      { char: '🤌', name: 'pinched fingers', keywords: ['chefkiss', 'italian'] },
      { char: '✌️', name: 'victory hand', keywords: ['peace', 'victory'] },
      { char: '🤞', name: 'crossed fingers', keywords: ['luck', 'hope'] },
      { char: '🤟', name: 'love-you gesture', keywords: ['love', 'ily'] },
      { char: '🤘', name: 'sign of the horns', keywords: ['rock', 'metal'] },
      { char: '👍', name: 'thumbs up', keywords: ['yes', 'like', 'approve', 'good'] },
      { char: '👎', name: 'thumbs down', keywords: ['no', 'dislike', 'bad'] },
      { char: '✊', name: 'raised fist', keywords: ['fist', 'power', 'solidarity'] },
      { char: '👊', name: 'oncoming fist', keywords: ['fist', 'punch', 'bump'] },
      { char: '🤝', name: 'handshake', keywords: ['deal', 'agreement', 'shake'] },
      { char: '🙏', name: 'folded hands', keywords: ['please', 'thanks', 'pray', 'hope'] },
      { char: '✍️', name: 'writing hand', keywords: ['write', 'note'] },
      { char: '💅', name: 'nail polish', keywords: ['nails', 'sassy'] },
      { char: '🫡', name: 'saluting face', keywords: ['salute', 'respect'] },
      { char: '👀', name: 'eyes', keywords: ['look', 'watching', 'suspicious'] },
      { char: '🧠', name: 'brain', keywords: ['smart', 'think', 'brain'] },
      { char: '🗣️', name: 'speaking head', keywords: ['talk', 'shout'] },
    ],
  },
  {
    id: 'animals',
    label: 'Animals & Nature',
    icon: '🐻',
    emojis: [
      { char: '🐶', name: 'dog face', keywords: ['dog', 'puppy', 'pet'] },
      { char: '🐱', name: 'cat face', keywords: ['cat', 'kitten', 'pet'] },
      { char: '🐭', name: 'mouse face', keywords: ['mouse'] },
      { char: '🐹', name: 'hamster', keywords: ['hamster', 'pet'] },
      { char: '🐰', name: 'rabbit face', keywords: ['rabbit', 'bunny'] },
      { char: '🦊', name: 'fox', keywords: ['fox'] },
      { char: '🐻', name: 'bear', keywords: ['bear'] },
      { char: '🐼', name: 'panda', keywords: ['panda'] },
      { char: '🐨', name: 'koala', keywords: ['koala'] },
      { char: '🐯', name: 'tiger face', keywords: ['tiger'] },
      { char: '🦁', name: 'lion', keywords: ['lion'] },
      { char: '🐮', name: 'cow face', keywords: ['cow'] },
      { char: '🐷', name: 'pig face', keywords: ['pig'] },
      { char: '🐸', name: 'frog', keywords: ['frog'] },
      { char: '🐵', name: 'monkey face', keywords: ['monkey'] },
      { char: '🙈', name: 'see-no-evil monkey', keywords: ['monkey', 'oops', 'shy'] },
      { char: '🙉', name: 'hear-no-evil monkey', keywords: ['monkey'] },
      { char: '🙊', name: 'speak-no-evil monkey', keywords: ['monkey', 'secret'] },
      { char: '🐔', name: 'chicken', keywords: ['chicken'] },
      { char: '🐧', name: 'penguin', keywords: ['penguin'] },
      { char: '🐦', name: 'bird', keywords: ['bird'] },
      { char: '🦆', name: 'duck', keywords: ['duck'] },
      { char: '🦉', name: 'owl', keywords: ['owl'] },
      { char: '🦇', name: 'bat', keywords: ['bat'] },
      { char: '🐺', name: 'wolf', keywords: ['wolf'] },
      { char: '🐗', name: 'boar', keywords: ['boar', 'pig'] },
      { char: '🐴', name: 'horse face', keywords: ['horse'] },
      { char: '🦄', name: 'unicorn', keywords: ['unicorn', 'magic'] },
      { char: '🐝', name: 'honeybee', keywords: ['bee'] },
      { char: '🐛', name: 'bug', keywords: ['bug', 'caterpillar'] },
      { char: '🦋', name: 'butterfly', keywords: ['butterfly'] },
      { char: '🐌', name: 'snail', keywords: ['snail', 'slow'] },
      { char: '🐞', name: 'lady beetle', keywords: ['ladybug', 'bug'] },
      { char: '🐜', name: 'ant', keywords: ['ant'] },
      { char: '🦗', name: 'cricket', keywords: ['cricket'] },
      { char: '🕷️', name: 'spider', keywords: ['spider'] },
      { char: '🐢', name: 'turtle', keywords: ['turtle', 'slow'] },
      { char: '🐍', name: 'snake', keywords: ['snake'] },
      { char: '🦎', name: 'lizard', keywords: ['lizard'] },
      { char: '🐙', name: 'octopus', keywords: ['octopus'] },
      { char: '🦑', name: 'squid', keywords: ['squid'] },
      { char: '🦀', name: 'crab', keywords: ['crab'] },
      { char: '🐠', name: 'tropical fish', keywords: ['fish'] },
      { char: '🐟', name: 'fish', keywords: ['fish'] },
      { char: '🐬', name: 'dolphin', keywords: ['dolphin'] },
      { char: '🐳', name: 'spouting whale', keywords: ['whale'] },
      { char: '🦈', name: 'shark', keywords: ['shark'] },
      { char: '🐊', name: 'crocodile', keywords: ['crocodile', 'alligator'] },
      { char: '🐘', name: 'elephant', keywords: ['elephant'] },
      { char: '🦒', name: 'giraffe', keywords: ['giraffe'] },
      { char: '🐫', name: 'two-hump camel', keywords: ['camel'] },
      { char: '🦘', name: 'kangaroo', keywords: ['kangaroo'] },
      { char: '🐐', name: 'goat', keywords: ['goat'] },
      { char: '🐑', name: 'ewe', keywords: ['sheep'] },
      { char: '🐕', name: 'dog', keywords: ['dog'] },
      { char: '🐈', name: 'cat', keywords: ['cat'] },
      { char: '🐓', name: 'rooster', keywords: ['rooster'] },
      { char: '🦃', name: 'turkey', keywords: ['turkey'] },
      { char: '🕊️', name: 'dove', keywords: ['dove', 'peace'] },
      { char: '🐇', name: 'rabbit', keywords: ['rabbit'] },
      { char: '🐿️', name: 'chipmunk', keywords: ['squirrel', 'chipmunk'] },
      { char: '🦔', name: 'hedgehog', keywords: ['hedgehog'] },
      { char: '🌵', name: 'cactus', keywords: ['cactus', 'plant'] },
      { char: '🌲', name: 'evergreen tree', keywords: ['tree', 'forest'] },
      { char: '🌳', name: 'deciduous tree', keywords: ['tree'] },
      { char: '🌴', name: 'palm tree', keywords: ['tree', 'tropical'] },
      { char: '🌱', name: 'seedling', keywords: ['plant', 'growth'] },
      { char: '🌿', name: 'herb', keywords: ['plant', 'herb'] },
      { char: '☘️', name: 'shamrock', keywords: ['luck', 'clover'] },
      { char: '🍀', name: 'four leaf clover', keywords: ['luck', 'clover'] },
      { char: '🌸', name: 'cherry blossom', keywords: ['flower', 'spring'] },
      { char: '🌹', name: 'rose', keywords: ['flower', 'love'] },
      { char: '🌻', name: 'sunflower', keywords: ['flower', 'sun'] },
      { char: '🌼', name: 'blossom', keywords: ['flower'] },
      { char: '🌷', name: 'tulip', keywords: ['flower'] },
      { char: '🍁', name: 'maple leaf', keywords: ['autumn', 'fall', 'leaf'] },
      { char: '🍂', name: 'fallen leaf', keywords: ['autumn', 'fall'] },
      { char: '🍃', name: 'leaf fluttering in wind', keywords: ['leaf', 'wind', 'nature'] },
      { char: '🌍', name: 'globe showing Europe-Africa', keywords: ['earth', 'world', 'globe'] },
      { char: '🌙', name: 'crescent moon', keywords: ['moon', 'night'] },
      { char: '⭐', name: 'star', keywords: ['star'] },
      { char: '🌟', name: 'glowing star', keywords: ['star', 'sparkle'] },
      { char: '☀️', name: 'sun', keywords: ['sun', 'sunny'] },
      { char: '⛅', name: 'sun behind cloud', keywords: ['cloudy', 'weather'] },
      { char: '🌧️', name: 'cloud with rain', keywords: ['rain', 'weather'] },
      { char: '⚡', name: 'high voltage', keywords: ['lightning', 'zap', 'electric'] },
      { char: '❄️', name: 'snowflake', keywords: ['snow', 'cold', 'winter'] },
      { char: '🔥', name: 'fire', keywords: ['fire', 'hot', 'lit'] },
      { char: '💧', name: 'droplet', keywords: ['water', 'drop', 'sweat'] },
      { char: '🌊', name: 'water wave', keywords: ['wave', 'ocean', 'sea'] },
    ],
  },
  {
    id: 'food',
    label: 'Food & Drink',
    icon: '🍔',
    emojis: [
      { char: '🍏', name: 'green apple', keywords: ['apple', 'fruit'] },
      { char: '🍎', name: 'red apple', keywords: ['apple', 'fruit'] },
      { char: '🍐', name: 'pear', keywords: ['pear', 'fruit'] },
      { char: '🍊', name: 'tangerine', keywords: ['orange', 'fruit'] },
      { char: '🍋', name: 'lemon', keywords: ['lemon', 'fruit', 'sour'] },
      { char: '🍌', name: 'banana', keywords: ['banana', 'fruit'] },
      { char: '🍉', name: 'watermelon', keywords: ['watermelon', 'fruit'] },
      { char: '🍇', name: 'grapes', keywords: ['grapes', 'fruit', 'wine'] },
      { char: '🍓', name: 'strawberry', keywords: ['strawberry', 'fruit'] },
      { char: '🫐', name: 'blueberries', keywords: ['blueberry', 'fruit'] },
      { char: '🍈', name: 'melon', keywords: ['melon', 'fruit'] },
      { char: '🍒', name: 'cherries', keywords: ['cherry', 'fruit'] },
      { char: '🍑', name: 'peach', keywords: ['peach', 'fruit', 'butt'] },
      { char: '🥭', name: 'mango', keywords: ['mango', 'fruit'] },
      { char: '🍍', name: 'pineapple', keywords: ['pineapple', 'fruit'] },
      { char: '🥥', name: 'coconut', keywords: ['coconut'] },
      { char: '🥝', name: 'kiwi fruit', keywords: ['kiwi', 'fruit'] },
      { char: '🍅', name: 'tomato', keywords: ['tomato'] },
      { char: '🍆', name: 'eggplant', keywords: ['eggplant', 'aubergine'] },
      { char: '🥑', name: 'avocado', keywords: ['avocado'] },
      { char: '🥦', name: 'broccoli', keywords: ['broccoli', 'vegetable'] },
      { char: '🥕', name: 'carrot', keywords: ['carrot', 'vegetable'] },
      { char: '🌽', name: 'ear of corn', keywords: ['corn'] },
      { char: '🌶️', name: 'hot pepper', keywords: ['spicy', 'pepper', 'chili'] },
      { char: '🥔', name: 'potato', keywords: ['potato'] },
      { char: '🍞', name: 'bread', keywords: ['bread', 'toast'] },
      { char: '🥐', name: 'croissant', keywords: ['croissant', 'bread'] },
      { char: '🥖', name: 'baguette bread', keywords: ['bread', 'baguette'] },
      { char: '🧀', name: 'cheese wedge', keywords: ['cheese'] },
      { char: '🥚', name: 'egg', keywords: ['egg'] },
      { char: '🍳', name: 'cooking', keywords: ['egg', 'frying', 'cooking'] },
      { char: '🥓', name: 'bacon', keywords: ['bacon'] },
      { char: '🥩', name: 'cut of meat', keywords: ['meat', 'steak'] },
      { char: '🍗', name: 'poultry leg', keywords: ['chicken', 'meat'] },
      { char: '🍔', name: 'hamburger', keywords: ['burger', 'food'] },
      { char: '🍟', name: 'french fries', keywords: ['fries', 'food'] },
      { char: '🍕', name: 'pizza', keywords: ['pizza', 'food'] },
      { char: '🌭', name: 'hot dog', keywords: ['hotdog', 'food'] },
      { char: '🥪', name: 'sandwich', keywords: ['sandwich', 'food'] },
      { char: '🌮', name: 'taco', keywords: ['taco', 'food'] },
      { char: '🌯', name: 'burrito', keywords: ['burrito', 'food'] },
      { char: '🥗', name: 'green salad', keywords: ['salad', 'healthy'] },
      { char: '🍿', name: 'popcorn', keywords: ['popcorn', 'movie'] },
      { char: '🍱', name: 'bento box', keywords: ['bento', 'lunch'] },
      { char: '🍣', name: 'sushi', keywords: ['sushi', 'food'] },
      { char: '🍤', name: 'fried shrimp', keywords: ['shrimp', 'food'] },
      { char: '🍜', name: 'steaming bowl', keywords: ['ramen', 'noodles', 'soup'] },
      { char: '🍝', name: 'spaghetti', keywords: ['pasta', 'food'] },
      { char: '🍛', name: 'curry rice', keywords: ['curry', 'food'] },
      { char: '🍚', name: 'cooked rice', keywords: ['rice'] },
      { char: '🥟', name: 'dumpling', keywords: ['dumpling', 'food'] },
      { char: '🍦', name: 'soft ice cream', keywords: ['icecream', 'dessert'] },
      { char: '🍩', name: 'doughnut', keywords: ['donut', 'dessert'] },
      { char: '🍪', name: 'cookie', keywords: ['cookie', 'dessert'] },
      { char: '🎂', name: 'birthday cake', keywords: ['cake', 'birthday'] },
      { char: '🍰', name: 'shortcake', keywords: ['cake', 'dessert'] },
      { char: '🧁', name: 'cupcake', keywords: ['cupcake', 'dessert'] },
      { char: '🍫', name: 'chocolate bar', keywords: ['chocolate', 'dessert'] },
      { char: '🍬', name: 'candy', keywords: ['candy', 'sweet'] },
      { char: '🍭', name: 'lollipop', keywords: ['candy', 'sweet'] },
      { char: '☕', name: 'hot beverage', keywords: ['coffee', 'tea'] },
      { char: '🍵', name: 'teacup without handle', keywords: ['tea'] },
      { char: '🧋', name: 'bubble tea', keywords: ['boba', 'tea'] },
      { char: '🍺', name: 'beer mug', keywords: ['beer', 'drink'] },
      { char: '🍻', name: 'clinking beer mugs', keywords: ['beer', 'cheers'] },
      { char: '🥂', name: 'clinking glasses', keywords: ['champagne', 'cheers', 'toast'] },
      { char: '🍷', name: 'wine glass', keywords: ['wine', 'drink'] },
      { char: '🍸', name: 'cocktail glass', keywords: ['cocktail', 'drink'] },
      { char: '🍹', name: 'tropical drink', keywords: ['cocktail', 'drink'] },
      { char: '🥃', name: 'tumbler glass', keywords: ['whiskey', 'drink'] },
    ],
  },
  {
    id: 'activities',
    label: 'Activities',
    icon: '⚽',
    emojis: [
      { char: '⚽', name: 'soccer ball', keywords: ['soccer', 'football'] },
      { char: '🏀', name: 'basketball', keywords: ['basketball'] },
      { char: '🏈', name: 'american football', keywords: ['football'] },
      { char: '⚾', name: 'baseball', keywords: ['baseball'] },
      { char: '🥎', name: 'softball', keywords: ['softball'] },
      { char: '🎾', name: 'tennis', keywords: ['tennis'] },
      { char: '🏐', name: 'volleyball', keywords: ['volleyball'] },
      { char: '🏉', name: 'rugby football', keywords: ['rugby'] },
      { char: '🎱', name: 'pool 8 ball', keywords: ['billiards', 'pool'] },
      { char: '🏓', name: 'ping pong', keywords: ['pingpong', 'tabletennis'] },
      { char: '🏸', name: 'badminton', keywords: ['badminton'] },
      { char: '🥊', name: 'boxing glove', keywords: ['boxing', 'fight'] },
      { char: '🥋', name: 'martial arts uniform', keywords: ['karate', 'judo'] },
      { char: '⛳', name: 'flag in hole', keywords: ['golf'] },
      { char: '🏹', name: 'bow and arrow', keywords: ['archery'] },
      { char: '🎣', name: 'fishing pole', keywords: ['fishing'] },
      { char: '🤿', name: 'diving mask', keywords: ['diving', 'snorkel'] },
      { char: '🥇', name: '1st place medal', keywords: ['gold', 'winner', 'first'] },
      { char: '🥈', name: '2nd place medal', keywords: ['silver', 'second'] },
      { char: '🥉', name: '3rd place medal', keywords: ['bronze', 'third'] },
      { char: '🏆', name: 'trophy', keywords: ['trophy', 'win', 'champion'] },
      { char: '🎮', name: 'video game', keywords: ['gaming', 'controller'] },
      { char: '🕹️', name: 'joystick', keywords: ['gaming', 'arcade'] },
      { char: '🎲', name: 'game die', keywords: ['dice', 'game'] },
      { char: '🧩', name: 'puzzle piece', keywords: ['puzzle'] },
      { char: '♟️', name: 'chess pawn', keywords: ['chess'] },
      { char: '🎯', name: 'direct hit', keywords: ['dart', 'target', 'bullseye'] },
      { char: '🎳', name: 'bowling', keywords: ['bowling'] },
      { char: '🎨', name: 'artist palette', keywords: ['art', 'paint'] },
      { char: '🎭', name: 'performing arts', keywords: ['theater', 'drama'] },
      { char: '🎬', name: 'clapper board', keywords: ['movie', 'film'] },
      { char: '🎤', name: 'microphone', keywords: ['sing', 'karaoke', 'mic'] },
      { char: '🎧', name: 'headphone', keywords: ['music', 'listen'] },
      { char: '🎼', name: 'musical score', keywords: ['music', 'sheet'] },
      { char: '🎹', name: 'musical keyboard', keywords: ['piano', 'music'] },
      { char: '🥁', name: 'drum', keywords: ['drum', 'music'] },
      { char: '🎸', name: 'guitar', keywords: ['guitar', 'music'] },
      { char: '🎻', name: 'violin', keywords: ['violin', 'music'] },
      { char: '🎺', name: 'trumpet', keywords: ['trumpet', 'music'] },
      { char: '🚴', name: 'person biking', keywords: ['cycling', 'bike'] },
      { char: '🏋️', name: 'person lifting weights', keywords: ['gym', 'workout', 'weights'] },
      { char: '🧗', name: 'person climbing', keywords: ['climbing'] },
      { char: '🏄', name: 'person surfing', keywords: ['surfing'] },
      { char: '🏊', name: 'person swimming', keywords: ['swimming'] },
      { char: '⛷️', name: 'skier', keywords: ['skiing'] },
      { char: '🏂', name: 'snowboarder', keywords: ['snowboarding'] },
      { char: '🎉', name: 'party popper', keywords: ['party', 'celebrate', 'congrats'] },
      { char: '🎊', name: 'confetti ball', keywords: ['party', 'confetti', 'celebrate'] },
      { char: '🎈', name: 'balloon', keywords: ['balloon', 'party'] },
      { char: '🎁', name: 'wrapped gift', keywords: ['gift', 'present'] },
      { char: '🏅', name: 'sports medal', keywords: ['medal', 'award'] },
    ],
  },
  {
    id: 'travel',
    label: 'Travel & Places',
    icon: '✈️',
    emojis: [
      { char: '🚗', name: 'automobile', keywords: ['car'] },
      { char: '🚕', name: 'taxi', keywords: ['taxi', 'cab'] },
      { char: '🚙', name: 'sport utility vehicle', keywords: ['suv', 'car'] },
      { char: '🚌', name: 'bus', keywords: ['bus'] },
      { char: '🚎', name: 'trolleybus', keywords: ['trolley', 'bus'] },
      { char: '🏎️', name: 'racing car', keywords: ['race', 'car', 'fast'] },
      { char: '🚓', name: 'police car', keywords: ['police', 'car'] },
      { char: '🚑', name: 'ambulance', keywords: ['ambulance', 'medical'] },
      { char: '🚒', name: 'fire engine', keywords: ['fire truck'] },
      { char: '🚚', name: 'delivery truck', keywords: ['truck', 'delivery'] },
      { char: '🚲', name: 'bicycle', keywords: ['bike', 'cycling'] },
      { char: '🛴', name: 'kick scooter', keywords: ['scooter'] },
      { char: '🏍️', name: 'motorcycle', keywords: ['motorbike'] },
      { char: '✈️', name: 'airplane', keywords: ['plane', 'flight', 'travel'] },
      { char: '🛫', name: 'airplane departure', keywords: ['flight', 'takeoff'] },
      { char: '🚀', name: 'rocket', keywords: ['rocket', 'launch', 'space'] },
      { char: '🛸', name: 'flying saucer', keywords: ['ufo', 'alien'] },
      { char: '🚁', name: 'helicopter', keywords: ['helicopter'] },
      { char: '⛵', name: 'sailboat', keywords: ['sailing', 'boat'] },
      { char: '🚤', name: 'speedboat', keywords: ['boat', 'speedboat'] },
      { char: '🛳️', name: 'passenger ship', keywords: ['ship', 'cruise'] },
      { char: '⚓', name: 'anchor', keywords: ['anchor', 'boat'] },
      { char: '🚂', name: 'locomotive', keywords: ['train'] },
      { char: '🚆', name: 'train', keywords: ['train'] },
      { char: '🚇', name: 'metro', keywords: ['subway', 'metro'] },
      { char: '🚦', name: 'traffic light', keywords: ['traffic', 'light'] },
      { char: '🗺️', name: 'world map', keywords: ['map', 'travel'] },
      { char: '🗽', name: 'Statue of Liberty', keywords: ['newyork', 'liberty'] },
      { char: '🗼', name: 'Tokyo tower', keywords: ['tokyo', 'tower'] },
      { char: '🏰', name: 'castle', keywords: ['castle'] },
      { char: '🏯', name: 'Japanese castle', keywords: ['castle', 'japan'] },
      { char: '🎡', name: 'ferris wheel', keywords: ['ferriswheel', 'carnival'] },
      { char: '🎢', name: 'roller coaster', keywords: ['rollercoaster', 'fun'] },
      { char: '🏖️', name: 'beach with umbrella', keywords: ['beach', 'vacation'] },
      { char: '🏝️', name: 'desert island', keywords: ['island', 'vacation'] },
      { char: '🏔️', name: 'snow-capped mountain', keywords: ['mountain', 'snow'] },
      { char: '⛰️', name: 'mountain', keywords: ['mountain'] },
      { char: '🌋', name: 'volcano', keywords: ['volcano'] },
      { char: '🏕️', name: 'camping', keywords: ['camping', 'tent'] },
      { char: '🏠', name: 'house', keywords: ['home', 'house'] },
      { char: '🏢', name: 'office building', keywords: ['office', 'building', 'work'] },
      { char: '🏨', name: 'hotel', keywords: ['hotel'] },
      { char: '🌉', name: 'bridge at night', keywords: ['bridge'] },
      { char: '🎆', name: 'fireworks', keywords: ['fireworks', 'celebration'] },
      { char: '🌃', name: 'night with stars', keywords: ['night', 'city'] },
      { char: '🌅', name: 'sunrise', keywords: ['sunrise', 'morning'] },
      { char: '🌄', name: 'sunrise over mountains', keywords: ['sunrise', 'mountain'] },
    ],
  },
  {
    id: 'objects',
    label: 'Objects',
    icon: '💡',
    emojis: [
      { char: '📱', name: 'mobile phone', keywords: ['phone', 'mobile'] },
      { char: '💻', name: 'laptop', keywords: ['computer', 'laptop'] },
      { char: '⌨️', name: 'keyboard', keywords: ['keyboard', 'typing'] },
      { char: '🖥️', name: 'desktop computer', keywords: ['computer', 'desktop'] },
      { char: '🖨️', name: 'printer', keywords: ['printer'] },
      { char: '🖱️', name: 'computer mouse', keywords: ['mouse'] },
      { char: '💾', name: 'floppy disk', keywords: ['save', 'disk'] },
      { char: '💿', name: 'optical disk', keywords: ['cd', 'disk'] },
      { char: '📷', name: 'camera', keywords: ['camera', 'photo'] },
      { char: '📹', name: 'video camera', keywords: ['video', 'camera'] },
      { char: '☎️', name: 'telephone', keywords: ['phone', 'call'] },
      { char: '📞', name: 'telephone receiver', keywords: ['phone', 'call'] },
      { char: '📺', name: 'television', keywords: ['tv'] },
      { char: '📻', name: 'radio', keywords: ['radio'] },
      { char: '⏰', name: 'alarm clock', keywords: ['alarm', 'clock', 'time'] },
      { char: '⏳', name: 'hourglass not done', keywords: ['time', 'wait'] },
      { char: '💡', name: 'light bulb', keywords: ['idea', 'light'] },
      { char: '🔦', name: 'flashlight', keywords: ['flashlight', 'light'] },
      { char: '🔋', name: 'battery', keywords: ['battery', 'power'] },
      { char: '🔌', name: 'electric plug', keywords: ['plug', 'charge'] },
      { char: '🧮', name: 'abacus', keywords: ['math', 'calculate'] },
      { char: '💰', name: 'money bag', keywords: ['money', 'rich'] },
      { char: '💵', name: 'dollar banknote', keywords: ['money', 'cash'] },
      { char: '💳', name: 'credit card', keywords: ['card', 'payment'] },
      { char: '📦', name: 'package', keywords: ['box', 'shipping', 'package'] },
      { char: '📧', name: 'e-mail', keywords: ['email', 'mail'] },
      { char: '📨', name: 'incoming envelope', keywords: ['mail', 'email'] },
      { char: '📩', name: 'envelope with arrow', keywords: ['mail', 'send'] },
      { char: '📝', name: 'memo', keywords: ['note', 'write'] },
      { char: '📌', name: 'pushpin', keywords: ['pin', 'note'] },
      { char: '📎', name: 'paperclip', keywords: ['attach', 'clip'] },
      { char: '📁', name: 'file folder', keywords: ['folder', 'file'] },
      { char: '📊', name: 'bar chart', keywords: ['chart', 'graph', 'stats'] },
      { char: '📈', name: 'chart increasing', keywords: ['chart', 'growth', 'stonks'] },
      { char: '📉', name: 'chart decreasing', keywords: ['chart', 'decline', 'loss'] },
      { char: '🔒', name: 'locked', keywords: ['lock', 'secure'] },
      { char: '🔓', name: 'unlocked', keywords: ['unlock', 'open'] },
      { char: '🔑', name: 'key', keywords: ['key', 'unlock'] },
      { char: '🔨', name: 'hammer', keywords: ['hammer', 'tool', 'build'] },
      { char: '🛠️', name: 'hammer and wrench', keywords: ['tools', 'fix', 'build'] },
      { char: '⚙️', name: 'gear', keywords: ['settings', 'gear', 'config'] },
      { char: '🧰', name: 'toolbox', keywords: ['tools', 'toolbox'] },
      { char: '🔍', name: 'magnifying glass tilted left', keywords: ['search', 'find', 'zoom'] },
      { char: '💊', name: 'pill', keywords: ['medicine', 'pill'] },
      { char: '🎁', name: 'wrapped gift', keywords: ['gift', 'present'] },
      { char: '📚', name: 'books', keywords: ['books', 'read'] },
      { char: '✏️', name: 'pencil', keywords: ['pencil', 'write'] },
      { char: '🖊️', name: 'pen', keywords: ['pen', 'write'] },
    ],
  },
  {
    id: 'symbols',
    label: 'Symbols',
    icon: '❤️',
    emojis: [
      { char: '❤️', name: 'red heart', keywords: ['love', 'heart'] },
      { char: '🧡', name: 'orange heart', keywords: ['love', 'heart'] },
      { char: '💛', name: 'yellow heart', keywords: ['love', 'heart'] },
      { char: '💚', name: 'green heart', keywords: ['love', 'heart'] },
      { char: '💙', name: 'blue heart', keywords: ['love', 'heart'] },
      { char: '💜', name: 'purple heart', keywords: ['love', 'heart'] },
      { char: '🖤', name: 'black heart', keywords: ['love', 'heart', 'dark'] },
      { char: '🤍', name: 'white heart', keywords: ['love', 'heart'] },
      { char: '🤎', name: 'brown heart', keywords: ['love', 'heart'] },
      { char: '💔', name: 'broken heart', keywords: ['heartbreak', 'sad'] },
      { char: '❣️', name: 'heart exclamation', keywords: ['love', 'heart'] },
      { char: '💕', name: 'two hearts', keywords: ['love', 'hearts'] },
      { char: '💞', name: 'revolving hearts', keywords: ['love', 'hearts'] },
      { char: '💓', name: 'beating heart', keywords: ['love', 'heart', 'pulse'] },
      { char: '💗', name: 'growing heart', keywords: ['love', 'heart'] },
      { char: '💖', name: 'sparkling heart', keywords: ['love', 'heart', 'sparkle'] },
      { char: '💘', name: 'heart with arrow', keywords: ['love', 'cupid'] },
      { char: '💝', name: 'heart with ribbon', keywords: ['love', 'gift'] },
      { char: '✨', name: 'sparkles', keywords: ['sparkle', 'shine', 'magic'] },
      { char: '💫', name: 'dizzy', keywords: ['star', 'sparkle'] },
      { char: '💥', name: 'collision', keywords: ['boom', 'explosion'] },
      { char: '💯', name: 'hundred points', keywords: ['100', 'perfect', 'score'] },
      { char: '✅', name: 'check mark button', keywords: ['check', 'done', 'yes'] },
      { char: '☑️', name: 'check box with check', keywords: ['check', 'done'] },
      { char: '✔️', name: 'check mark', keywords: ['check', 'done'] },
      { char: '❌', name: 'cross mark', keywords: ['x', 'no', 'wrong'] },
      { char: '❎', name: 'cross mark button', keywords: ['x', 'no'] },
      { char: '⭕', name: 'hollow red circle', keywords: ['circle', 'ring'] },
      { char: '❗', name: 'exclamation mark', keywords: ['exclamation', 'warning'] },
      { char: '❓', name: 'question mark', keywords: ['question', 'confused'] },
      { char: '❕', name: 'white exclamation mark', keywords: ['exclamation'] },
      { char: '❔', name: 'white question mark', keywords: ['question'] },
      { char: '⚠️', name: 'warning', keywords: ['warning', 'caution'] },
      { char: '🚫', name: 'prohibited', keywords: ['no', 'banned', 'forbidden'] },
      { char: '♻️', name: 'recycling symbol', keywords: ['recycle', 'green'] },
      { char: '🔞', name: 'no one under eighteen', keywords: ['18', 'restricted'] },
      { char: '📵', name: 'no mobile phones', keywords: ['nophone', 'silence'] },
      { char: '🔇', name: 'muted speaker', keywords: ['mute', 'silent'] },
      { char: '🔊', name: 'speaker high volume', keywords: ['loud', 'volume'] },
      { char: '🔔', name: 'bell', keywords: ['notification', 'bell', 'alert'] },
      { char: '🔕', name: 'bell with slash', keywords: ['mute', 'silent'] },
      { char: '💬', name: 'speech balloon', keywords: ['chat', 'message', 'talk'] },
      { char: '💭', name: 'thought balloon', keywords: ['thought', 'think'] },
      { char: '🗯️', name: 'right anger bubble', keywords: ['angry', 'shout'] },
      { char: '🔄', name: 'counterclockwise arrows', keywords: ['refresh', 'reload', 'sync'] },
      { char: '🆗', name: 'OK button', keywords: ['ok'] },
      { char: '🆕', name: 'NEW button', keywords: ['new'] },
      { char: '🔝', name: 'TOP arrow', keywords: ['top', 'up'] },
      { char: '🔀', name: 'shuffle tracks button', keywords: ['shuffle', 'random'] },
    ],
  },
];

// Flat lookup used by search — built once at module load rather than on
// every keystroke, since the underlying category data never changes at
// runtime.
const ALL_EMOJIS = EMOJI_CATEGORIES.flatMap((cat) => cat.emojis);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function matchesQuery(entry, query) {
  return entry.name.includes(query) || entry.keywords.some((k) => k.includes(query));
}

// Creates the widget without touching the DOM yet — mirrors
// createFullscreenViewer's shape: a mount point up front, then
// open()/close() drive an internal panel that's created and torn down
// per-use rather than kept around hidden, same as this module's own
// caller does with reactionPickerEl in room-view.js.
export function createEmojiBrowser(mountEl) {
  let panelEl = null;
  let onPick = null;
  let activeCategoryId = EMOJI_CATEGORIES[0].id;

  function close() {
    document.removeEventListener('pointerdown', onOutsidePointerDown);
    document.removeEventListener('keydown', onKeydown);
    panelEl?.remove();
    panelEl = null;
    onPick = null;
  }

  // pointerdown (not click) for the same reason room-view.js's own
  // reaction-picker outside-click handler uses it: this needs to have
  // already closed by the time any click handler elsewhere (e.g. a
  // second right-click opening a *different* message's quick-react menu)
  // runs, not race it.
  function onOutsidePointerDown(e) {
    if (!panelEl || panelEl.contains(e.target)) return;
    close();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  function renderTabs() {
    return EMOJI_CATEGORIES
      .map((cat) => `<button class="mx-emoji-browser-tab${cat.id === activeCategoryId ? ' mx-emoji-browser-tab-active' : ''}" data-category="${cat.id}" title="${escapeHtml(cat.label)}" type="button">${cat.icon}</button>`)
      .join('');
  }

  function renderGrid(gridEl, query) {
    const q = query.trim().toLowerCase();
    const list = q
      ? ALL_EMOJIS.filter((e) => matchesQuery(e, q))
      : (EMOJI_CATEGORIES.find((c) => c.id === activeCategoryId) || EMOJI_CATEGORIES[0]).emojis;

    gridEl.innerHTML = list.length
      ? list.map((e) => `<button class="mx-emoji-browser-cell" data-emoji="${e.char}" title="${escapeHtml(e.name)}" type="button">${e.char}</button>`).join('')
      : `<div class="mx-emoji-browser-empty">No emoji found</div>`;
  }

  // anchorRect is any DOMRect-like object (left/right/top) — a real
  // getBoundingClientRect() result, not raw x/y — so this always opens
  // relative to a real element's actual box, not a single point a
  // caller has to compute by hand (which is how the button-vs-composer
  // mismatch happened before: a button's rect isn't its container's
  // rect, even though they look close).
  //
  // align: 'left' (default) anchors this panel's left edge to
  // anchorRect.left, same as the quick-react menu's "More emoji…"
  // handler wants (open rightward-and-up from the menu it replaced).
  // 'right' anchors this panel's right edge to anchorRect.right
  // instead, for the composer's emoji button, which sits mid-row in a
  // wider bar — the picker should line up with the bar's own right
  // edge, not the button's left edge partway across it.
  //
  // Either way, top is always anchored from anchorRect.top (this
  // panel's BOTTOM lands there, growing upward) — never the caller's
  // own inner button/click point, so there's always real clearance
  // above whatever bar or menu this was opened from.
  function open(anchorRect, pickCallback, { align = 'left' } = {}) {
    close();
    onPick = pickCallback;

    panelEl = document.createElement('div');
    panelEl.className = 'mx-emoji-browser';
    panelEl.innerHTML = `
      <input class="mx-emoji-browser-search" type="text" placeholder="Search emoji…" />
      <div class="mx-emoji-browser-tabs">${renderTabs()}</div>
      <div class="mx-emoji-browser-grid"></div>
    `;
    mountEl.appendChild(panelEl);

    const searchEl = panelEl.querySelector('.mx-emoji-browser-search');
    const tabsEl = panelEl.querySelector('.mx-emoji-browser-tabs');
    const gridEl = panelEl.querySelector('.mx-emoji-browser-grid');
    renderGrid(gridEl, '');

    // Clamped against mountEl (the .mx-room-view panel passed in by
    // room-view.js), not window — this is the matrix-chat panel's own
    // widget, so it should stay within that panel's bounds even when
    // the Electron window is much bigger (e.g. a wide sidebar layout).
    // getBoundingClientRect() returns viewport coordinates regardless
    // of mountEl's own CSS position, matching this panel's own
    // position: fixed (see styles.css) coordinate space.
    const bounds = mountEl.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = panelEl;

    // GAP leaves a small breathing space between this panel's bottom
    // and whatever bar/menu it opened from (the composer, or the
    // quick-react menu), rather than butting flush against it.
    const GAP = 8;
    const desiredLeft = align === 'right' ? anchorRect.right - w : anchorRect.left;
    const left = Math.max(bounds.left + 4, Math.min(desiredLeft, bounds.right - w - 4));
    const top = Math.max(bounds.top + 4, Math.min(anchorRect.top - h - GAP, bounds.bottom - h - 4));
    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;

    searchEl.addEventListener('input', () => renderGrid(gridEl, searchEl.value));

    tabsEl.addEventListener('click', (e) => {
      const tab = e.target.closest('.mx-emoji-browser-tab');
      if (!tab) return;
      activeCategoryId = tab.dataset.category;
      searchEl.value = '';
      tabsEl.querySelectorAll('.mx-emoji-browser-tab').forEach((t) => {
        t.classList.toggle('mx-emoji-browser-tab-active', t === tab);
      });
      renderGrid(gridEl, '');
    });

    gridEl.addEventListener('click', (e) => {
      const cell = e.target.closest('.mx-emoji-browser-cell');
      if (!cell) return;
      onPick?.(cell.dataset.emoji);
      close();
    });

    // Focus after insertion (not before) so the panel is actually in the
    // DOM and focusable — matches the timing every other "open a popover
    // then focus its input" flow needs.
    searchEl.focus();

    document.addEventListener('pointerdown', onOutsidePointerDown);
    document.addEventListener('keydown', onKeydown);
  }

  return { open, close, isOpen: () => panelEl !== null };
}
