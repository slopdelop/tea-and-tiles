// Hand-picked familiar words for a one-time family setup ticket. These are
// intentionally easy to type, rather than a permanent password vocabulary.
export const SETUP_WORDS = `
acorn apple apricot autumn bamboo banana basket beach berry biscuit blanket blossom breeze bridge bubble button
butter candle canyon carrot castle cherry cheese citrus clover coconut coffee cookie cotton cupcake daisy dolphin
donut dragon dream feather flower forest garden ginger grapes harbor harvest hazel honey island jasmine kettle
kitten lemon lilac maple meadow melon muffin nutmeg ocean orange orchid otter panda papaya peach peanut
pebble pepper picnic pillow planet plumage pocket poppy potato pumpkin rabbit rainbow raisin ribbon ripple river
robin rocket rosebud salmon sandal sandy saucer school sesame shadow shell silver snowy sparrow spring stone
summer sunset table teacup thistle timber tomato tulip turtle valley velvet violet walnut willow window winter
wonder wooden yellow yogurt zebra zipper almond anchor angel animal artist avenue balloon beacon beaver bedroom
beetle bench bicycle bonfire bottle branch bright bronze bucket cabin cactus camera camping caramel carpet cartoon
celery cereal chapel chicken chimney circle cloud cobalt copper coral corner cradle creamy cricket crystal cushion
dancer dinner drawing evening family farmer fiddle finger flannel floral fluffy freezer friend frosty galaxy gentle
golden grassy guitar hammock happy hearth helmet holiday horses hungry icicle indoors jacket jigsaw journey joyful
jumper lagoon lantern lettuce library little lively lobster lovely lucky mailbox marble market marsh mellow memory
mirror monkey morning mouse napkin nature needle noodle olive onion outdoor painter palace pantry parcel pastry
penguin people petal picture pigeon platter playful prairie present pretty puddle puzzle quiet quilt radial reading
recipe record redwood relax round rowing royal rubber saddle sailing sailor secret shining shower sleepy smiling
`.trim().split(/\s+/).map(word => word.toUpperCase());

if (SETUP_WORDS.length !== 256 || new Set(SETUP_WORDS).size !== 256 || SETUP_WORDS.some(word => !/^[A-Z]{5,7}$/.test(word)))
  throw new Error("The setup vocabulary must contain 256 unique familiar words of 5–7 letters.");

export const WORD_FAILURE_BUCKET = "enrollmentAttempts/word-failures";
