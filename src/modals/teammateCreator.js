// ---------------------------------------------------------------------------
// 队友创建弹窗
// ---------------------------------------------------------------------------
import { openModal } from './shell.js';
import { createCharacter, refreshDerived, rollAttributes } from '../core/character.js';
import { fillSkillPoints } from '../services/charGen.js';

export function openTeammateCreator(state, onChanged) {
  const { backdrop, close } = openModal(`
    <div class="modal">
      <div class="modal-head">
        <h2>添加 AI 队友</h2>
        <button class="icon-btn" data-close>×</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span>姓名</span>
          <input id="tmName" type="text" placeholder="例如：林默">
        </label>
        <label class="field">
          <span>职业</span>
          <input id="tmOcc" type="text" placeholder="例如：退伍军医">
        </label>
        <label class="field">
          <span>性格设定（决定他怎么说话）</span>
          <textarea id="tmPersona" rows="3" placeholder="例如：话少，抽烟，遇到血会下意识检查伤口。表面冷漠但护着队友。"></textarea>
          <em>写得越具体，AI 演得越像真人</em>
        </label>
        <label class="field">
          <span>擅长技能（用逗号分隔，会自动设为高值）</span>
          <input id="tmSkills" type="text" placeholder="急救, 医学, 射击">
        </label>
        <div class="module-actions">
          <button class="btn ghost" id="btnRollT">随机属性</button>
          <span class="hint">属性会自动掷骰生成</span>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" id="btnCreateT">创建</button>
      </div>
    </div>
  `);

  const ch = createCharacter({ name: '队友', isPlayer: false });
  ch.attrs = rollAttributes();
  refreshDerived(ch);

  backdrop.querySelector('#btnRollT').onclick = () => {
    ch.attrs = rollAttributes();
    refreshDerived(ch);
  };

  backdrop.querySelector('#btnCreateT').onclick = () => {
    ch.name = backdrop.querySelector('#tmName').value.trim() || '无名队友';
    ch.occupation = backdrop.querySelector('#tmOcc').value.trim() || '调查员';
    ch.persona = backdrop.querySelector('#tmPersona').value.trim() || '冷静、务实，话不多。';

    const picks = backdrop.querySelector('#tmSkills').value.split(/[,，、\s]+/).filter(Boolean);
    for (const sk of picks) {
      ch.skills[sk] = Math.max(ch.skills[sk] ?? 0, 60);
    }

    // 把没花完的职业点/兴趣点补齐。
    //
    // 这条路径原来是直接 push 进 state.teammates 的，完全没走补点逻辑：
    // 玩家填个职业、点两项擅长技能，生成的队友职业点能剩 250 点、
    // 兴趣点剩 150 点（实测），在跑团里就是个废人——技能检定几乎过不了。
    // 现在统一交给 fillSkillPoints 收尾，和其他车卡入口保持一致。
    fillSkillPoints(ch);

    state.teammates.push(ch);
    onChanged?.();
    close();
  };
}
