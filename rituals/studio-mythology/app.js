const poses = [
  {
    key: "seated",
    name: "Seated Pose",
    sanskrit: "Sukhasana-adjacent",
    image: "assets/seated.png",
    alt: "Stylized yoga illustration of a seated pose.",
    vibes: ["soft", "clear"],
    represents: "arrival",
    mood: "soft and gathered",
    summary: "For the days when you want your energy to feel cleaner, quieter, and less scattered.",
    myth: "This is the pose of return. Cross the legs, lengthen the spine, soften the face, and everything starts to feel a little more graceful. It reads as calm before you even say anything.",
    body: "The body gets still enough for the breath to become the main event. Your jaw eases, your shoulders stop performing, and your attention has somewhere lovely to land.",
    ritual: "Reach for this when you want to feel like you belong to yourself again."
  },
  {
    key: "tree",
    name: "Tree Pose",
    sanskrit: "Vrksasana",
    image: "assets/tree.png",
    alt: "Stylized yoga illustration of Tree Pose.",
    vibes: ["confident", "clear"],
    represents: "self-possession",
    mood: "collected and luminous",
    summary: "For the days when you want to feel composed, upright, and a little bit unbothered.",
    myth: "Tree Pose is rooted elegance. The kind of balance that feels feminine without feeling fragile. It gives poised, centered, quietly expensive energy.",
    body: "One point to look at. One standing leg to trust. One clean line rising through the body. That simplicity is what makes the confidence feel real instead of forced.",
    ritual: "Reach for this when you want steadiness to read as beauty."
  },
  {
    key: "warrior-ii",
    name: "Warrior II",
    sanskrit: "Virabhadrasana II",
    image: "assets/warrior-ii.png",
    alt: "Stylized yoga illustration of Warrior II.",
    vibes: ["confident", "open"],
    represents: "boundaries",
    mood: "steady and magnetic",
    summary: "For the days when you want strength, but in a way that still feels elegant.",
    myth: "Warrior II is pure boundary magic. Strong legs, level arms, soft eyes. It is the pose version of knowing exactly what you are available for and what you are not.",
    body: "The legs create heat, the back foot anchors the shape, and the arms pull the whole body into one long decision. You feel clearer because the pose is clear.",
    ritual: "Reach for this when you want your softness to keep its standards."
  },
  {
    key: "triangle",
    name: "Triangle Pose",
    sanskrit: "Trikonasana",
    image: "assets/triangle.png",
    alt: "Stylized yoga illustration of Triangle Pose.",
    vibes: ["clear", "confident"],
    represents: "clarity",
    mood: "precise and polished",
    summary: "For the days when you want your energy to feel cleaner, sharper, and impossibly well put together.",
    myth: "Triangle is clarity in a beautiful outfit. One long line, one open chest, one body arranged into clean geometry. It feels polished, elevated, and very sure of itself.",
    body: "When the pose is supported well, the breath gets quieter and the whole shape starts to glow instead of strain. That is where the polished feeling comes from.",
    ritual: "Reach for this when you want to feel refined instead of rushed."
  },
  {
    key: "bow",
    name: "Bow Pose",
    sanskrit: "Dhanurasana",
    image: "assets/bow.png",
    alt: "Stylized yoga illustration of Bow Pose.",
    vibes: ["open", "confident"],
    represents: "openness",
    mood: "radiant and brave",
    summary: "For the days when you want a heart opener that feels a little bit cinematic.",
    myth: "Bow Pose is heart-opening with a little drama, which is exactly why people love it. The chest lifts, the thighs rise, and suddenly the whole front body feels bright, vulnerable, and alive.",
    body: "Quads, shoulders, chest, and spine all light up at once. It is effortful, but in a way that makes the openness feel earned and delicious.",
    ritual: "Reach for this when you want to feel open without becoming flimsy."
  }
];

const modeLabels = {
  myth: "The Vibe",
  body: "What It Opens",
  ritual: "Afterglow"
};

const grid = document.getElementById("pose-grid");
const modeButtons = [...document.querySelectorAll("[data-mode]")];
const vibeButtons = [...document.querySelectorAll("[data-vibe]")];
const shuffleButton = document.getElementById("shuffle-pose");

const detailTargets = {
  art: document.getElementById("detail-art"),
  tag: document.getElementById("detail-tag"),
  title: document.getElementById("detail-title"),
  sanskrit: document.getElementById("detail-sanskrit"),
  summary: document.getElementById("detail-summary"),
  modeLabel: document.getElementById("detail-mode-label"),
  main: document.getElementById("detail-main"),
  represents: document.getElementById("detail-represents"),
  mood: document.getElementById("detail-mood")
};

let activeMode = "myth";
let activePoseKey = "triangle";
let activeVibe = "all";

function getVisiblePoses() {
  if (activeVibe === "all") {
    return poses;
  }

  return poses.filter((pose) => pose.vibes.includes(activeVibe));
}

function renderCards() {
  const visiblePoses = getVisiblePoses();

  grid.innerHTML = visiblePoses.map((pose) => `
    <button class="pose-card${pose.key === activePoseKey ? " active" : ""}" type="button" data-pose="${pose.key}" role="listitem">
      <div class="pose-art">
        <img src="${pose.image}" alt="${pose.alt}">
      </div>
      <div class="pose-meta">
        <div>
          <h3 class="pose-name">${pose.name}</h3>
          <p class="pose-sanskrit">${pose.sanskrit}</p>
        </div>
        <span class="pose-represents">${pose.represents}</span>
      </div>
      <p class="pose-copy"><strong>${pose.represents}</strong> energy. ${pose.summary}</p>
    </button>
  `).join("");

  grid.querySelectorAll("[data-pose]").forEach((button) => {
    button.addEventListener("click", () => {
      activePoseKey = button.dataset.pose;
      renderCards();
      renderDetail();
    });
  });
}

function renderDetail() {
  const pose = poses.find((item) => item.key === activePoseKey);
  if (!pose) {
    return;
  }

  detailTargets.art.src = pose.image;
  detailTargets.art.alt = pose.alt;
  detailTargets.tag.textContent = "Energy";
  detailTargets.title.textContent = pose.name;
  detailTargets.sanskrit.textContent = pose.sanskrit;
  detailTargets.summary.textContent = pose.summary;
  detailTargets.modeLabel.textContent = modeLabels[activeMode];
  detailTargets.main.textContent = pose[activeMode];
  detailTargets.represents.textContent = pose.represents;
  detailTargets.mood.textContent = pose.mood;
}

function setMode(mode) {
  activeMode = mode;

  modeButtons.forEach((button) => {
    const isActive = button.dataset.mode === mode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  renderDetail();
}

function setVibe(vibe) {
  activeVibe = vibe;

  vibeButtons.forEach((button) => {
    const isActive = button.dataset.vibe === vibe;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  const visiblePoses = getVisiblePoses();
  if (!visiblePoses.some((pose) => pose.key === activePoseKey)) {
    activePoseKey = visiblePoses[0].key;
  }

  renderCards();
  renderDetail();
}

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setMode(button.dataset.mode);
  });
});

vibeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setVibe(button.dataset.vibe);
  });
});

shuffleButton.addEventListener("click", () => {
  const visiblePoses = getVisiblePoses();
  const nextPose = visiblePoses[Math.floor(Math.random() * visiblePoses.length)];
  activePoseKey = nextPose.key;
  renderCards();
  renderDetail();
});

setVibe(activeVibe);
setMode(activeMode);
