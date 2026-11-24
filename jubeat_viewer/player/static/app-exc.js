(() => {
  'use strict';
  const A = window.JubeatApp;
  const view = document.getElementById('excView');
  if (!A || !view) return;
  const stage = view.closest('.stage');
  const openButton = document.getElementById('btnExcView');
  const about = openButton.closest('details');
  const versionPicker = document.getElementById('excVersion');
  const versionToggle = document.getElementById('excVersionToggle');
  const cover = document.getElementById('excCover');
  const title = document.getElementById('excVersionName');
  const release = document.getElementById('excRelease');
  const description = document.getElementById('excVersionDescription');
  const video = document.getElementById('excVideo');
  const still = document.getElementById('excStill');
  const status = document.getElementById('excStatus');
  const {display, labels} = window.JubeatVersions;
  const descriptions = {
    jubeat: '系列初代，以 4×4 发光面板随节奏点按。',
    'jubeat-ripples': '系列第二作，新增多首 J-POP，可自办比赛。',
    'jubeat-knit': '同曲可跨难度匹配，还加入了双人组队参赛。',
    'jubeat-copious-append': 'copious 扩充版，推出 APPEND TRAVEL 跨机种联动。',
    'jubeat-saucer': '以餐厅为主题，收集食材做料理解锁曲目。',
    'jubeat-saucer-fulfill': 'saucer 的后续更新，新增连续多曲的段位挑战。',
    'jubeat-prop': '首次加入长押音符，并以 STEP 记录成长进度。',
    'jubeat-qubell': '加入「コレスキ？」推荐功能，按游玩偏好推荐歌曲。',
    'jubeat-clan': '以四座城镇为主题，可选择一座加入并解锁曲目。',
    'jubeat-festo': '系列十周年版本，收录纪念曲与新设计的封面。',
    'jubeat-ave': '通过 LIGHT CHAT 角色活动解锁曲目。',
    'jubeat-beyond-ave': '系列第十二作，收录同名原创曲与征集获奖谱面。',
    '音乐魔方': 'KONAMI 授权、华立科技发行的中国大陆街机版。',
  };
  const versions = new Map([
    ['01', {key: 'jubeat', image: 'exc-01-trs_res_excellent.webp'}],
    ['02', {key: 'jubeat-ripples'}],
    ['03', {key: 'jubeat-knit'}],
    ['04', {key: 'jubeat-copious-append'}],
    ['05', {key: 'jubeat-saucer'}],
    ['06', {key: 'jubeat-saucer-fulfill'}],
    ['07', {key: 'jubeat-prop'}],
    ['08', {key: 'jubeat-qubell'}],
    ['09', {key: 'jubeat-clan'}],
    ['11', {key: 'jubeat-festo'}],
    ['12', {key: 'jubeat-ave'}],
    ['13', {key: 'jubeat-beyond-ave', edition: '2025'}],
    ['15', {
      key: 'jubeat-beyond-ave', edition: '2026', movie: 'exc-13.mp4',
      description: 'beyond the Ave. 持续更新，追加了新机台的场测曲目。',
    }],
    ['wahlap', {key: '音乐魔方', movie: 'exc-wahlap-exc-unity-result.mp4', portrait: true}],
  ]);

  let selectedId = '02';
  const choices = new Map();
  for (const [id, version] of versions) {
    version.name = display[version.key] + (version.edition ? ` · ${version.edition} 版` : '');
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.value = id;
    choice.textContent = version.name;
    choice.setAttribute('aria-pressed', String(id === selectedId));
    choices.set(id, choice);
    versionPicker.append(choice);
  }
  const setPickerOpen = A.bindChoicePicker(versionToggle, versionPicker, choice => {
    if (choice.value === selectedId) return;
    choices.get(selectedId).setAttribute('aria-pressed', 'false');
    selectedId = choice.value;
    choice.setAttribute('aria-pressed', 'true');
    showAnimation();
  });
  let videoRequest = 0;
  let mutedForAutoplay = false;

  function resetVideo() {
    videoRequest += 1;
    video.controls = true;
    if (!video.hasAttribute('src')) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (mutedForAutoplay) {
      video.muted = false;
      mutedForAutoplay = false;
    }
  }

  function showAnimation() {
    const id = selectedId;
    const version = versions.get(id);
    const month = labels[version.key].match(/(\d{4})-(\d{2})/);
    const logo = A.versionLibrary.logoPath(version.key);
    if (cover.getAttribute('src') !== logo) cover.src = logo;
    title.textContent = version.name;
    release.dateTime = month[0];
    release.textContent = `${month[1]} 年 ${Number(month[2])} 月`;
    description.textContent = version.description ?? descriptions[version.key];
    resetVideo();
    video.hidden = Boolean(version.image);
    still.hidden = !version.image;
    status.hidden = !version.image;
    if (version.image) {
      still.src = A.resourcePath(`static/${version.image}`);
      status.textContent = '该版本目前仅有 EXCELLENT 结算标识。';
      return;
    }
    const file = version.movie ?? `exc-${id}.mp4`;
    video.classList.toggle('is-portrait', Boolean(version.portrait));
    video.setAttribute('aria-label', `${version.name} EXC 结算特效`);
    video.src = A.resourcePath(`static/${file}`);
    const request = videoRequest;
    video.play().catch(error => {
      if (error.name !== 'NotAllowedError' || request !== videoRequest || video.muted) return;
      mutedForAutoplay = true;
      video.muted = true;
      video.play().catch(() => {});
    });
  }

  function open() {
    A.pause();
    stage.classList.add('is-exc');
    view.hidden = false;
    openButton.setAttribute('aria-expanded', 'true');
    about.open = false;
    if (A.isNarrow()) A.setSidebarOpen(false);
    showAnimation();
    versionToggle.focus();
  }

  function close(restoreFocus = true) {
    if (view.hidden) return;
    setPickerOpen(false);
    view.hidden = true;
    resetVideo();
    stage.classList.remove('is-exc');
    openButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) (A.isNarrow() ? A.els.btnSidebarOpen : about.querySelector('summary')).focus();
  }

  openButton.addEventListener('click', open);
  document.getElementById('btnCloseExc').addEventListener('click', () => close());
  video.addEventListener('playing', () => { video.controls = video.paused; });
  video.addEventListener('pause', () => { if (video.paused) video.controls = true; });
  video.addEventListener('ended', () => { video.controls = true; });
  video.addEventListener('click', () => { if (!video.controls) video.pause(); });
  video.addEventListener('keydown', event => {
    if (video.controls || (event.key !== ' ' && event.key !== 'Enter')) return;
    event.preventDefault();
    video.pause();
  });
  video.addEventListener('error', () => {
    if (view.hidden || !video.error) return;
    status.hidden = false;
    status.textContent = '动画加载失败，可切换版本后重试。';
  });
  view.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    close();
  });
  A.excView = {get active() { return !view.hidden; }, close};
})();
