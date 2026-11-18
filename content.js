// Canned content for the mock. No model is called anywhere.
//
// Inline markup inside sentences:
//   [[term]] or [[shown text|term]]   a glossed term (key into TERMS)
//   *text*                            emphasis
//
// A sentence is a string, or { t, topic } when a canned branch exists for the
// whole sentence. `anchors` lists phrases inside the text that also have a
// canned branch.

const VERBS = {
  why: { short: 'Why?', q: 'Why is this true?' },
  what: { short: 'Meaning', q: 'What does this mean?' },
  example: { short: 'Example', q: 'Show me an example' },
  simpler: { short: 'Simpler', q: 'Say it more simply' },
};

// level 1 = basic vocabulary (hidden for the "Knows ML basics" reader)
// level 2 = specific to this topic
const TERMS = {
  'output distribution': {
    level: 1,
    short: 'The probabilities a model gives to each possible answer. They add up to 1.',
    more: [
      'A classifier does not output a single answer.',
      'It outputs one number per class, and after the [[softmax]] those numbers are probabilities that sum to 1.',
      'The answer it “gives” is just the class with the largest one; distillation uses all of them.',
    ],
  },
  'hard label': {
    level: 1,
    short: 'A training target that names only the correct class: 100% on it, 0% on everything else.',
    more: [
      'Most datasets record one correct class per example.',
      'As a training target that becomes a distribution with all of its weight on that class.',
      'It is called hard in contrast to a [[soft target|soft targets]], which spreads weight over several classes.',
    ],
  },
  'dark knowledge': {
    level: 2,
    short: "Hinton's name for what a model knows beyond its top answer: how it ranks the wrong ones.",
    more: [
      'Most of what a model has learned does not show in its top answer.',
      'It sits in the relative sizes of the probabilities the model gives to everything else.',
      'Distillation is a way of transferring that part.',
    ],
  },
  logits: {
    level: 1,
    short: 'The raw scores a network gives each class, before they are turned into probabilities.',
    more: [
      'The last layer of a classifier produces one unbounded number per class.',
      'These are the logits.',
      'A higher logit means the network favours that class more, but they are not probabilities until the [[softmax]] is applied.',
    ],
  },
  temperature: {
    level: 2,
    short: 'A number T that the logits are divided by. T = 1 changes nothing; a larger T evens the probabilities out.',
    more: [
      'The name comes from physics, where the same formula describes how particles spread over energy levels: hotter means more evenly spread.',
      'In distillation, T is chosen by experiment, and values from about 2 to 20 are common.',
    ],
  },
  softmax: {
    level: 1,
    short: 'The function that turns raw scores into probabilities: exponentiate each score, then divide by the total.',
    more: [
      'Exponentiating makes every score positive and stretches the gaps between them, so the largest score takes most of the probability.',
      'Dividing by the total makes them sum to 1.',
    ],
  },
  'KL divergence': {
    level: 2,
    short: 'A measure of how far one probability distribution is from another. It is zero only when they match.',
    more: [
      'It compares two distributions class by class and penalises the student most where the teacher puts weight that the student does not.',
      "Minimising it pulls the student's whole distribution toward the teacher's, not just its top answer.",
    ],
  },
  'cross-entropy': {
    level: 1,
    short: 'The standard classification loss. It is small when the model puts high probability on the correct class.',
    more: [
      'With a [[hard label]], cross-entropy reduces to the negative log of the probability the model gave the correct class.',
      'Putting 99% there costs almost nothing; putting 1% there costs a lot.',
    ],
  },
  gradient: {
    level: 1,
    short: "The direction and size of the adjustment a training step makes to the model's weights.",
    more: [
      'Training works out how the loss would change if each weight moved slightly, then moves the weights the other way.',
      'A large gradient means a large correction; a gradient near zero means the model learns nothing from that example.',
    ],
  },
  hyperparameter: {
    level: 1,
    short: 'A setting chosen before training, such as the learning rate, rather than learned from the data.',
    more: [
      'Weights are learned by training; hyperparameters are the choices made around it.',
      'They are usually set by trying several values and keeping the one that scores best on held-out data.',
    ],
  },
  ensemble: {
    level: 1,
    short: 'Several separately trained models whose predictions are averaged.',
    more: [
      "Averaging cancels out some of each model's individual mistakes, so an ensemble is usually more accurate than any one member.",
      'The cost is that every prediction means running all of them.',
    ],
  },
  'soft targets': {
    level: 2,
    short: "The teacher's softened probabilities, used as what the student aims for.",
    more: [
      'A soft target spreads probability across several classes instead of putting it all on one.',
      "In distillation the soft targets are the teacher's outputs at [[temperature]] T.",
    ],
  },
};

const CONTENT = {
  root: {
    paras: [
      [
        { t: 'Knowledge distillation trains a small model, the student, to imitate a large one, the teacher.', topic: 'whydistill' },
        { t: "Instead of learning only from the correct answers, the student learns to match the teacher's whole [[output distribution]]: the probability it gives to every possible answer.", topic: 'match' },
      ],
      [
        { t: "This works because the teacher's wrong answers carry information.", topic: 'dark' },
        { t: 'Shown a photo of a dog, a good teacher might say 95% dog, 4.7% wolf and 0.01% car.', topic: 'dognums' },
        { t: 'That wolf is hundreds of times more likely than car says something about what dogs look like, and a [[hard label]] of just “dog” throws it away.', topic: 'hard' },
        { t: 'Hinton called this hidden signal [[dark knowledge]].', topic: 'term:dark knowledge' },
      ],
      [
        { t: 'In a confident teacher those small probabilities are so close to zero that they barely affect training.', topic: 'tiny' },
        { t: 'To bring them out, both models divide their [[logits]] by a [[temperature]] T before the [[softmax]].', topic: 'temp' },
        { t: 'A higher T flattens the distribution, so the differences among unlikely answers become visible.', topic: 'flatten' },
      ],
      [
        { t: 'The student is trained on a weighted sum of two losses.', topic: 'twoloss' },
        { t: 'One is the [[KL divergence]] between the softened teacher and student distributions, multiplied by T².', topic: 'klloss' },
        { t: 'The other is ordinary [[cross-entropy]] against the true labels.', topic: 'ce' },
        { t: 'Once trained, the student runs at T = 1 like any other model.', topic: 't1' },
      ],
    ],
    anchors: [
      { phrase: 'multiplied by T²', topic: 'tsq' },
      { phrase: "the teacher's wrong answers carry information", topic: 'dark' },
      { phrase: 'weighted sum of two losses', topic: 'twoloss' },
      { phrase: 'flattens the distribution', topic: 'flatten' },
    ],
  },

  'whydistill.why': {
    paras: [[
      'Large models are accurate but slow and expensive to run.',
      "A student can be many times smaller and still keep most of the teacher's accuracy, which makes it cheap enough to serve at scale or to fit on a phone.",
      'It also usually ends up more accurate than the same small model trained on the labels alone.',
    ]],
  },

  'match.why': {
    paras: [[
      'Correct answers only tell the student what to say.',
      "The teacher's distribution also tells it how sure to be and which mistakes are reasonable.",
      { t: 'That is more information per training example, and it is available even for examples that have no labels at all.', topic: 'unlabeled' },
    ]],
    anchors: [{ phrase: 'examples that have no labels at all', topic: 'unlabeled' }],
  },
  'match.simpler': {
    paras: [[
      'A label is a one-word answer key.',
      "The teacher's distribution is the teacher talking through the question: “almost certainly a dog, could just about be a wolf, definitely not a car.”",
      'The student learns from the commentary as well as the key.',
    ]],
  },

  'unlabeled.what': {
    paras: [[
      'The teacher can produce a distribution for any input, whether or not anyone has labelled it.',
      "So the student can train on raw, unlabelled data with the teacher's outputs as its only target.",
      'This is common when labelled data is scarce but unlabelled data is plentiful.',
    ]],
  },

  'dark.why': {
    paras: [[
      'A trained teacher has learned which classes resemble each other, and that shows in how it spreads probability over the wrong answers.',
      'Mistaking a dog for a wolf is a small error; mistaking it for a car is a large one.',
      { t: "A student that copies those proportions inherits the teacher's sense of similarity instead of having to rediscover it from the data.", topic: 'similarity' },
    ]],
    anchors: [{ phrase: "the teacher's sense of similarity", topic: 'similarity' }],
  },
  'dark.example': {
    paras: [[
      'Take handwritten digits.',
      'Shown a 2, a teacher might give 98% to 2, 1% to 3 and 0.5% to 7.',
      'A different 2, drawn with a flat top, might get more 7 than 3.',
      'So each image arrives with its own note on what it nearly looks like.',
    ]],
  },
  'dark.simpler': {
    paras: [[
      "The teacher's second and third guesses are hints.",
      'They tell the student which things look alike.',
    ]],
  },

  'similarity.example': {
    paras: [[
      'In the original distillation paper, a student was trained on handwritten digits without ever being shown a 3.',
      'It still got most 3s right at test time.',
      "The teacher's outputs on the other digits kept saying things like “this 8 looks a little like a 3,” and that was enough.",
    ]],
  },

  'dognums.what': {
    paras: [[
      "These three numbers are part of the teacher's [[output distribution]] for one image.",
      'They are made up for illustration, but the shape is typical: nearly everything on one class, and the remainder spread very unevenly over the rest.',
    ]],
  },

  'hard.what': {
    paras: [[
      'A hard label puts 100% on the correct class and 0% on every other.',
      'Against that target, calling the dog a wolf and calling it a car are equally wrong.',
      'The student gets no hint that one of them was a near miss.',
    ]],
  },
  'hard.example': {
    paras: [[
      'As targets for the dog photo, the hard label is dog 100%, wolf 0%, car 0%.',
      "The teacher's version is dog 95%, wolf 4.7%, car 0.01%.",
      'Only the second one says anything about wolves.',
    ]],
  },

  'tiny.why': {
    paras: [[
      "Training nudges the student in proportion to the gap between its probabilities and the target's.",
      'If the target says car is 0.0001 and the student says 0.0002, the gap is tiny and so is the nudge.',
      'The information is in the target, but at that scale it produces almost no [[gradient]].',
    ]],
  },

  'temp.what': {
    paras: [[
      "Normally the softmax makes each probability proportional to exp(z), where z is that class's logit.",
      'With a temperature it uses exp(z / T) instead.',
      'T = 1 is the ordinary softmax.',
      'As T grows the probabilities move toward each other, and as T shrinks toward 0 the top class takes everything.',
    ]],
  },
  'temp.example': {
    paras: [[
      'Suppose the logits are 9 for dog, 6 for wolf and 0 for car.',
      'Here is what the softmax gives at three temperatures.',
    ]],
    widget: 'tempTable',
  },
  'temp.simpler': {
    paras: [[
      'Temperature is a contrast dial.',
      'Turn it up and the gap between the confident answer and the unlikely ones shrinks, so you can see detail among the unlikely ones.',
    ]],
  },

  'flatten.example': {
    paras: [[
      'Take logits of 9 for dog, 6 for wolf and 0 for car.',
      'Drag T and watch car go from invisible to a real share of the total.',
    ]],
    widget: 'tempSlider',
  },
  'flatten.why': {
    paras: [[
      'Dividing by T shrinks the gaps between the logits.',
      'The softmax depends only on those gaps, so smaller gaps give more even probabilities.',
      'The ranking never changes: dog stays ahead of wolf, and wolf stays ahead of car.',
    ]],
  },

  'twoloss.why': {
    paras: [[
      'The teacher is sometimes wrong, and the true labels are the check on that.',
      'The label loss keeps the student anchored to the right answer when the teacher slips; the teacher loss supplies everything else.',
      'The original paper found it worked best to give the label loss a much smaller weight.',
    ]],
  },

  'klloss.what': {
    paras: [[
      'Both models run on the same input at the same temperature T, which gives two softened distributions.',
      "The KL divergence measures how far the student's is from the teacher's, and training reduces it.",
      "This is the part of the loss that carries the teacher's knowledge.",
    ]],
  },

  'tsq.why': {
    paras: [[
      { t: 'Softening the distributions also shrinks the gradients that this loss produces, by a factor of about 1/T².', topic: 'tsqwhy' },
      "Left alone, raising T would quietly turn down the teacher's influence relative to the label loss.",
      'Multiplying by T² cancels that, so the balance between the two losses stays put whatever T you pick.',
    ]],
    anchors: [{ phrase: 'by a factor of about 1/T²', topic: 'tsqwhy' }],
  },
  'tsq.simpler': {
    paras: [[
      "Raising T makes the teacher's loss quieter.",
      'T² is the volume knob that turns it back up by the same amount.',
    ]],
  },

  'tsqwhy.why': {
    paras: [[
      'One factor of 1/T comes from the logits being divided by T before the softmax.',
      "The other comes from the softened probabilities themselves: at high T the gap between the teacher's and the student's probabilities is itself about 1/T as large.",
      'Multiply the two and you get 1/T².',
    ]],
  },

  'ce.what': {
    paras: [[
      'This is the loss the student would use if there were no teacher: it rewards putting high probability on the labelled class.',
      "It is computed at T = 1, on the student's normal outputs.",
    ]],
  },

  // Answers to typed follow-up questions (see ASKS below).
  'ask.choosetemp': {
    paras: [[
      'There is no formula; T is tuned like any other [[hyperparameter]].',
      "A low T, close to 1, keeps the teacher's distribution sharp, so the student mostly sees the top answer.",
      { t: 'A high T spreads it out, which exposes more of the similarity between classes but also amplifies noise in the very small logits.', topic: 'noise' },
      'The original paper found that very small students did best at moderate temperatures, because they cannot absorb all the detail that a high T reveals.',
    ]],
    anchors: [{ phrase: 'amplifies noise in the very small logits', topic: 'noise' }],
  },
  'noise.why': {
    paras: [[
      'The teacher was trained to get its top answers right.',
      'Nothing pushed it to be precise about whether an unlikely class deserves 0.0001 or 0.00001, so those tiny values are partly arbitrary.',
      'A high T magnifies exactly that part of the distribution.',
    ]],
  },
  'ask.toohigh': {
    paras: [[
      'At a very high T the softened distribution approaches uniform: every class gets nearly the same probability.',
      'The differences the student is supposed to learn shrink toward nothing.',
      "What is left is dominated by the teacher's noise in logits it never needed to get right.",
    ]],
  },
  'ask.samearch': {
    paras: [[
      'No.',
      'The student only has to produce outputs over the same set of classes, because the loss compares output distributions and nothing inside the networks.',
      'The teacher can even be an [[ensemble]] of several models whose predictions are averaged.',
      'That was the original motivation: compress an ensemble into a single model that is cheap to run.',
    ]],
  },
  'ask.lm': {
    paras: [[
      'Yes.',
      "The same idea is used to train small language models from large ones: the student is trained to match the teacher's probability distribution over words.",
      'DistilBERT is a well-known example, about 40% smaller than BERT while keeping most of its accuracy.',
    ]],
  },
  'ask.whynotlabels': {
    paras: [[
      'You can, and that is the baseline distillation is compared against.',
      'It usually ends up less accurate.',
      "A label tells the student only which class is right; the teacher's distribution also tells it how the wrong classes relate, which the small model would otherwise have to work out from far more data.",
    ]],
  },

  't1.why': {
    paras: [[
      "Temperature is a training device for exposing the teacher's small probabilities.",
      "At test time you want the student's actual best guess, and dividing the logits by T never changes which class comes first.",
      'So T goes back to 1 and the student behaves like any ordinary classifier.',
    ]],
  },
};

// label:    short name shown in the map
// def:      the verb the "AI" guesses when you point at this passage
// answers:  verb -> CONTENT key
// takeaway: the one line a resolved branch collapses to
// points:   key points for "explain it back"; each needs every regex in `all`
const TOPICS = {
  root: {
    label: 'How does knowledge distillation work?',
    points: [
      { label: "The student learns to match the teacher's outputs", all: [/teacher/i, /match|imitat|cop(y|ies)|mimic|learn/i] },
      { label: 'Wrong answers carry information about similarity', all: [/wrong|other|unlikely|small|similar|resembl|alike/i] },
      { label: 'Temperature softens the distributions', all: [/temperature|soften|flatten|\bT\b/] },
      { label: "Two losses: the teacher's distribution and the true labels", all: [/label/i, /loss|both|two/i] },
    ],
  },
  whydistill: {
    label: 'Why distill at all',
    def: 'why',
    answers: { why: 'whydistill.why' },
    takeaway: "A small student keeps most of the teacher's accuracy at a fraction of the cost.",
    points: [
      { label: 'The large model is too costly to run', all: [/cost|expensive|slow|cheap|fast|small/i] },
      { label: 'The student keeps most of the accuracy', all: [/accura|perform|as good|quality/i] },
    ],
  },
  match: {
    label: 'Matching the whole distribution',
    def: 'why',
    answers: { why: 'match.why', simpler: 'match.simpler' },
    takeaway: 'The distribution tells the student how sure to be and which mistakes are reasonable, not only the right answer.',
    points: [
      { label: 'A distribution carries more than a label', all: [/more (information|signal|than)|richer|not (just|only)/i] },
      { label: 'It says which mistakes are reasonable', all: [/mistake|wrong|similar|confiden|sure/i] },
    ],
  },
  unlabeled: {
    label: 'Training without labels',
    def: 'what',
    answers: { what: 'unlabeled.what' },
    takeaway: 'The teacher can label any input, so the student is not limited to labelled data.',
  },
  dark: {
    label: 'Wrong answers carry information',
    def: 'why',
    answers: { why: 'dark.why', example: 'dark.example', simpler: 'dark.simpler' },
    takeaway: "The teacher's spread over wrong answers encodes which classes resemble each other.",
    points: [
      { label: 'Wrong answers are not equally wrong', all: [/wrong|mistake|error|unlikely|small prob/i] },
      { label: 'Their proportions encode similarity between classes', all: [/similar|resembl|alike|close to|related/i] },
    ],
  },
  similarity: {
    label: 'Inherited sense of similarity',
    def: 'example',
    answers: { example: 'similarity.example' },
    takeaway: "A student learned to recognise 3s without seeing one, purely from the teacher's soft outputs.",
  },
  dognums: {
    label: 'The dog / wolf / car numbers',
    def: 'what',
    answers: { what: 'dognums.what' },
    takeaway: 'Illustrative numbers: one dominant class, the rest spread unevenly.',
  },
  hard: {
    label: 'What a hard label throws away',
    def: 'what',
    answers: { what: 'hard.what', example: 'hard.example' },
    takeaway: 'A hard label treats every wrong answer as equally wrong.',
    points: [
      { label: 'All the weight goes on the correct class', all: [/100|all|only|one class|single/i] },
      { label: 'Every wrong answer looks equally wrong', all: [/equal|same|no (hint|difference|information)|near miss/i] },
    ],
  },
  tiny: {
    label: 'Small probabilities barely train',
    def: 'why',
    answers: { why: 'tiny.why' },
    takeaway: 'Near-zero probabilities produce near-zero gradients, so the student barely learns from them.',
    points: [
      { label: 'The training signal scales with the size of the gap', all: [/gap|difference|proportion|gradient|nudge|signal/i] },
      { label: 'Near-zero probabilities give near-zero signal', all: [/tiny|small|zero|almost no|barely/i] },
    ],
  },
  temp: {
    label: 'Dividing logits by T',
    def: 'what',
    answers: { what: 'temp.what', example: 'temp.example', simpler: 'temp.simpler' },
    takeaway: 'Dividing logits by T before the softmax evens out the probabilities; T = 1 is normal.',
    points: [
      { label: 'Logits are divided by T before the softmax', all: [/divid|z\s*\/\s*t|before (the )?softmax|scal/i] },
      { label: 'Higher T makes the distribution more even', all: [/flat|even|smooth|soft|uniform|closer/i] },
    ],
  },
  flatten: {
    label: 'Higher T flattens',
    def: 'example',
    answers: { example: 'flatten.example', why: 'flatten.why' },
    takeaway: 'Higher T shrinks the gaps between logits, which evens out the probabilities without changing their order.',
    points: [
      { label: 'Dividing by T shrinks the gaps between logits', all: [/gap|difference|shrink|smaller|divid/i] },
      { label: 'The order of the classes does not change', all: [/order|rank|still|same/i] },
    ],
  },
  twoloss: {
    label: 'Why two losses',
    def: 'why',
    answers: { why: 'twoloss.why' },
    takeaway: 'Labels keep the student correct where the teacher is wrong; the teacher supplies the rest.',
    points: [
      { label: 'The teacher can be wrong', all: [/wrong|mistake|error|slip/i] },
      { label: 'Labels anchor the student to the correct answer', all: [/label|ground truth|correct/i] },
    ],
  },
  klloss: {
    label: 'The KL term',
    def: 'what',
    answers: { what: 'klloss.what' },
    takeaway: "The KL term pulls the student's softened distribution toward the teacher's.",
  },
  tsq: {
    label: 'Why multiply by T²',
    def: 'why',
    answers: { why: 'tsq.why', simpler: 'tsq.simpler' },
    takeaway: 'T² restores the gradient scale that softening removes, keeping the two losses in balance.',
    points: [
      { label: 'Softening shrinks the gradients by about 1/T²', all: [/shrink|small|1\s*\/\s*t|scale|weak|quiet/i] },
      { label: 'T² keeps the two losses in balance', all: [/balance|cancel|compensat|relative|restor|weight/i] },
    ],
  },
  tsqwhy: {
    label: 'Where 1/T² comes from',
    def: 'why',
    answers: { why: 'tsqwhy.why' },
    takeaway: 'One 1/T from scaling the logits, another from the softened gap itself.',
  },
  ce: {
    label: 'The label loss',
    def: 'what',
    answers: { what: 'ce.what' },
    takeaway: 'The ordinary label loss, computed at T = 1.',
  },
  t1: {
    label: 'Why T = 1 after training',
    def: 'why',
    answers: { why: 't1.why' },
    takeaway: 'Temperature is only for training; it never changes the top answer.',
  },
  noise: {
    label: 'High T amplifies noise',
    def: 'why',
    answers: { why: 'noise.why' },
    takeaway: "The teacher's tiniest logits are partly arbitrary, and a high T magnifies them.",
  },
};

// Typed follow-up questions that have a canned answer. They are offered as
// chips above the message box, and typed text is matched against `match`.
// `next` lists follow-ups that make sense after this one.
const ASKS = {
  choosetemp: {
    q: 'How do I choose the temperature?',
    content: 'ask.choosetemp',
    match: /(choose|pick|set|select|tune|best|right|which).*temperature/i,
    next: ['toohigh'],
  },
  toohigh: {
    q: 'What goes wrong if T is too high?',
    content: 'ask.toohigh',
    match: /too (high|large|big|hot)/i,
  },
  samearch: {
    q: 'Does the student need the same architecture as the teacher?',
    content: 'ask.samearch',
    match: /architecture|same (kind|type|shape|design)|different (model|network)/i,
    next: ['lm'],
  },
  lm: {
    q: 'Does this work for language models too?',
    content: 'ask.lm',
    match: /language model|\bLLMs?\b|\bGPT\b|\bBERT\b|text model/i,
  },
  whynotlabels: {
    q: 'Why not just train the small model on the labels?',
    content: 'ask.whynotlabels',
    match: /(just|only|simply|directly).*(label|data)|without (a |the )?teacher/i,
  },
};

// Follow-ups offered after the opening answer.
const STARTERS = ['choosetemp', 'samearch', 'whynotlabels'];

// Every glossed term can also be opened as a full branch.
for (const [key, term] of Object.entries(TERMS)) {
  TOPICS['term:' + key] = { label: key, def: 'what', answers: { what: 'term:' + key }, takeaway: term.short };
  CONTENT['term:' + key] = { paras: [term.more] };
}

// Branches the "AI" proposes without being asked, keyed by the topic of the
// pane they appear in.
const SUGGEST = {
  root: {
    topic: 'tsq',
    phrase: 'multiplied by T²',
    verb: 'why',
    why: 'You have not opened this, and the balance between the two losses depends on it.',
  },
};
