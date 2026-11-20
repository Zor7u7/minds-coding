/** Recomendador transparente; no certifica dominio ni infiere estados mentales. */

const ALLOWED_PHASES = new Set(["diagnostic", "retry", "post_intervention_check", "post_intervention_transfer"]);

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("es-MX")
    .replace(/[−–—]/g, "-")
    .replace(/\s+/g, "")
    .replace(/[.,]$/, "");
}

function correctResponses(question) {
  return [question.answer, ...(question.acceptedAnswers ?? [])]
    .filter((value) => value !== undefined)
    .map(normalize);
}

function validateConfig(config) {
  const issues = [];
  const skillIds = new Set(config.skills.map((skill) => skill.id));
  const errorIds = new Set(config.errorCodes.map((error) => error.id));
  const questionIds = new Set();
  for (const skill of config.skills) {
    if (!skill.observableCriterion) issues.push(`${skill.id}: falta criterio observable.`);
    for (const prerequisite of skill.prerequisites ?? []) {
      if (!skillIds.has(prerequisite)) issues.push(`${skill.id}: prerrequisito inexistente (${prerequisite}).`);
    }
  }
  for (const question of config.questionBank) {
    if (questionIds.has(question.id)) issues.push(`Reactivo duplicado: ${question.id}.`);
    questionIds.add(question.id);
    if (!skillIds.has(question.skillId)) issues.push(`${question.id}: habilidad inexistente (${question.skillId}).`);
    if (!question.prompt || !question.format || question.answer === undefined) issues.push(`${question.id}: falta enunciado, formato o respuesta/criterio esperado.`);
    for (const code of Object.values(question.errorMap ?? {})) {
      if (!errorIds.has(code)) issues.push(`${question.id}: patrón de error inexistente (${code}).`);
    }
  }
  for (const activity of config.activities) {
    if (!skillIds.has(activity.targetsSkillId)) issues.push(`${activity.id}: habilidad objetivo inexistente.`);
    for (const code of activity.targetsErrorCodes ?? []) if (!errorIds.has(code)) issues.push(`${activity.id}: patrón objetivo inexistente (${code}).`);
    for (const id of activity.checkQuestionIds ?? []) {
      const question = config.questionBank.find((item) => item.id === id);
      if (!question) issues.push(`${activity.id}: reactivo de comprobación inexistente (${id}).`);
      else if (!question.postInterventionOnly || question.skillId !== activity.targetsSkillId) {
        issues.push(`${activity.id}: ${id} no es un reactivo nuevo de comprobación para la habilidad objetivo.`);
      }
    }
    const transfer = config.questionBank.find((item) => item.id === activity.transferQuestionId);
    if (!transfer) issues.push(`${activity.id}: reactivo de transferencia inexistente (${activity.transferQuestionId}).`);
    else if (!transfer.postInterventionOnly || !transfer.transferOnly || transfer.skillId !== activity.targetsSkillId) {
      issues.push(`${activity.id}: su reactivo de transferencia no es exclusivo o no mide la habilidad objetivo.`);
    }
  }
  for (const route of Object.values(config.gradeRoutes)) {
    const positions = new Map(route.skillIds.map((id, index) => [id, index]));
    for (const id of route.skillIds) {
      const skill = config.skills.find((item) => item.id === id);
      if (!skill) issues.push(`Ruta ${route.label}: habilidad inexistente (${id}).`);
      else for (const prerequisite of skill.prerequisites ?? []) {
        if (!positions.has(prerequisite)) issues.push(`Ruta ${route.label}: falta el prerrequisito ${prerequisite} de ${id}.`);
        else if (positions.get(prerequisite) >= positions.get(id)) issues.push(`Ruta ${route.label}: ${id} aparece antes de su prerrequisito ${prerequisite}.`);
      }
    }
  }
  const rules = config.decisionRules;
  if (!config.gradeRoutes.default) issues.push("Falta la ruta default.");
  if (!rules || !Number.isInteger(rules.minimumEvidence) || !rules.errorPattern ||
      !rules.support || !rules.advance || !rules.postInterventionCheck) {
    issues.push("Faltan reglas de decisión requeridas.");
  } else if (!Number.isInteger(rules.errorPattern.minRepeatedErrors) ||
      !Number.isInteger(rules.support.minIndependentItems) ||
      !Number.isFinite(rules.support.maxAccuracyExclusive) ||
      !Number.isInteger(rules.advance.minIndependentItems) ||
      !Number.isFinite(rules.advance.minAccuracy) ||
      !Number.isInteger(rules.advance.minFormats) ||
      !Number.isInteger(rules.postInterventionCheck.parallelItems) ||
      !Number.isInteger(rules.postInterventionCheck.correctRequired) ||
      !Number.isInteger(rules.postInterventionCheck.transferItems) ||
      !Number.isInteger(rules.postInterventionCheck.transferCorrectRequired)) {
    issues.push("Los umbrales de decisión deben tener tipos numéricos válidos.");
  }
  return issues;
}

function independent(event) {
  return event.phase !== "retry" &&
    event.attemptNumber === 1 &&
    event.hintCount === 0 &&
    event.feedbackSeen === false &&
    event.workedExampleSeen === false &&
    event.supportLevel === 0;
}

function prepareHistory(history, config) {
  const questionById = new Map(config.questionBank.map((question) => [question.id, question]));
  const knownErrors = new Set(config.errorCodes.map((item) => item.id));
  const issues = [];
  const prepared = [];

  for (const [index, event] of history.entries()) {
    if (!event || typeof event !== "object") {
      issues.push(`Registro ${index + 1}: debe ser un objeto de respuesta.`);
      continue;
    }
    const question = questionById.get(event.questionId);
    if (!question) {
      issues.push(`Registro ${index + 1}: questionId desconocido (${event.questionId ?? "vacío"}).`);
      continue;
    }
    if (event.skillId && event.skillId !== question.skillId) {
      issues.push(`Registro ${index + 1}: skillId no coincide con el reactivo ${question.id}.`);
      continue;
    }
    if (typeof event.correct !== "boolean" || typeof event.response !== "string" || !ALLOWED_PHASES.has(event.phase) ||
        !Number.isInteger(event.attemptNumber) || event.attemptNumber < 1 ||
        !Number.isInteger(event.hintCount) || event.hintCount < 0 ||
        typeof event.feedbackSeen !== "boolean" || typeof event.workedExampleSeen !== "boolean" ||
        !Number.isFinite(event.supportLevel) || event.supportLevel < 0 ||
        typeof event.timestamp !== "string" || Number.isNaN(Date.parse(event.timestamp))) {
      issues.push(`Registro ${index + 1}: faltan campos válidos de resultado o condiciones de ayuda para ${question.id}.`);
      continue;
    }

    const normalizedResponse = normalize(event.response);
    const expectedCorrect = correctResponses(question).includes(normalizedResponse);
    if (normalizedResponse && expectedCorrect && !event.correct) {
      issues.push(`Registro ${index + 1}: una respuesta aceptada aparece marcada como incorrecta en ${question.id}.`);
      continue;
    }

    const matchedError = Object.entries(question.errorMap ?? {})
      .find(([response]) => normalize(response) === normalizedResponse)?.[1] ?? null;
    if (matchedError && event.correct) {
      issues.push(`Registro ${index + 1}: un distractor conocido aparece marcado como correcto en ${question.id}.`);
      continue;
    }
    if (event.errorCode && (!knownErrors.has(event.errorCode) || event.errorCode !== matchedError)) {
      issues.push(`Registro ${index + 1}: errorCode no corresponde a un distractor configurado de ${question.id}.`);
      continue;
    }
    if (matchedError && event.errorCode && event.errorCode !== matchedError) {
      issues.push(`Registro ${index + 1}: el error informado no coincide con el distractor seleccionado en ${question.id}.`);
      continue;
    }
    if (event.phase === "post_intervention_check" || event.phase === "post_intervention_transfer") {
      const intervention = config.activities.find((item) => item.id === event.activityId);
      const activityQuestions = event.phase === "post_intervention_check"
        ? intervention?.checkQuestionIds
        : [intervention?.transferQuestionId];
      if (!intervention || !activityQuestions.includes(question.id)) {
        issues.push(`Registro ${index + 1}: reactivo posterior no corresponde a la actividad indicada.`);
        continue;
      }
    }

    prepared.push({
      ...event,
      skillId: question.skillId,
      format: question.format,
      errorCode: matchedError ?? null,
      _question: question
    });
  }
  return { prepared, issues };
}

function firstIndependentAttempts(events, skillId, phase = "diagnostic") {
  const ordered = [...events]
    .filter((event) => event.skillId === skillId && event.phase === phase)
    .sort((a, b) => a.attemptNumber - b.attemptNumber ||
      String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  const seen = new Set();
  const result = [];
  for (const event of ordered) {
    if (seen.has(event.questionId)) continue;
    seen.add(event.questionId);
    if (independent(event)) result.push(event);
  }
  return result;
}

function summarize(events) {
  const correct = events.filter((event) => event.correct).length;
  const errors = new Map();
  for (const event of events) {
    if (!event.correct && event.errorCode) errors.set(event.errorCode, (errors.get(event.errorCode) ?? 0) + 1);
  }
  return {
    n: events.length,
    correct,
    accuracy: events.length ? correct / events.length : null,
    errors,
    formats: new Set(events.map((event) => event.format))
  };
}

function recommendation(action, fields = {}) {
  return { action, activityId: null, questionId: null, checkQuestionIds: [], nextSkillId: null, reason: "", evidence: {}, ...fields };
}

function evidenceFor(skillId, stage, stats) {
  return {
    skillId,
    stage,
    independentItems: stats.n,
    correct: stats.correct,
    accuracy: stats.accuracy,
    errorCounts: Object.fromEntries(stats.errors),
    formatsObserved: [...stats.formats]
  };
}

/**
 * Every event must carry questionId, correct, response, attemptNumber, hintCount,
 * feedbackSeen, workedExampleSeen, supportLevel, phase, and timestamp.
 * `pendingIntervention` is persisted by the caller after showing a returned activity.
 */
export function decideNext({ history, currentGrade, config, currentSkillId,
  completedActivityIds = [], pendingIntervention = null }) {
  if (!Array.isArray(history) || !Array.isArray(config?.questionBank) || !Array.isArray(config?.skills) ||
      !Array.isArray(config?.errorCodes) || !Array.isArray(config?.activities) || !config?.gradeRoutes ||
      !config?.decisionRules) {
    return recommendation("data_review", { reason: "Falta el historial o la configuración del motor no tiene la estructura requerida." });
  }
  const configIssues = validateConfig(config);
  if (configIssues.length) return recommendation("data_review", {
    reason: "La configuración tiene referencias inconsistentes; corregirlas antes de adaptar la ruta.",
    evidence: { issues: configIssues }
  });

  const { prepared, issues } = prepareHistory(history, config);
  if (issues.length) return recommendation("data_review", { reason: "Hay registros inconsistentes; corregirlos antes de adaptar la ruta.", evidence: { issues } });

  const { skills, activities, decisionRules, gradeRoutes } = config;
  if (pendingIntervention) {
    const activity = activities.find((item) => item.id === pendingIntervention.activityId);
    if (!activity) return recommendation("data_review", { reason: "La intervención pendiente no existe en la configuración." });
    const required = activity.checkQuestionIds ?? [];
    const checkEvents = firstIndependentAttempts(prepared.filter((event) =>
      event.activityId === activity.id && required.includes(event.questionId)), activity.targetsSkillId, "post_intervention_check");
    const attempted = new Set(prepared
      .filter((event) => event.activityId === activity.id && event.phase === "post_intervention_check")
      .map((event) => event.questionId));
    const nextCheck = required.find((id) => !attempted.has(id));
    const checkPassed = checkEvents.length >= decisionRules.postInterventionCheck.parallelItems &&
      checkEvents.filter((event) => event.correct).length >= decisionRules.postInterventionCheck.correctRequired;
    const checkEvidence = {
      activityId: activity.id,
      requiredItems: required.length,
      completedItems: checkEvents.length,
      correct: checkEvents.filter((event) => event.correct).length
    };

    if (checkPassed) {
      const transferAttempted = prepared.some((event) =>
        event.activityId === activity.id && event.questionId === activity.transferQuestionId &&
        event.phase === "post_intervention_transfer");
      const transferEvents = firstIndependentAttempts(prepared.filter((event) =>
        event.activityId === activity.id && event.questionId === activity.transferQuestionId),
      activity.targetsSkillId, "post_intervention_transfer");
      if (!transferAttempted) return recommendation("post_intervention_transfer", {
        activityId: activity.id,
        questionId: activity.transferQuestionId,
        reason: "Los dos reactivos paralelos se resolvieron de forma independiente. Presentar ahora una tarea nueva de transferencia, en otro contexto o formato.",
        evidence: { ...checkEvidence, transferItemsRequired: decisionRules.postInterventionCheck.transferItems }
      });
      if (transferEvents.length >= decisionRules.postInterventionCheck.transferItems &&
          transferEvents.filter((event) => event.correct).length >= decisionRules.postInterventionCheck.transferCorrectRequired) {
        const route = gradeRoutes[String(currentGrade)] ?? gradeRoutes.default;
        const nextSkillId = route.skillIds[route.skillIds.indexOf(activity.targetsSkillId) + 1] ?? null;
        return recommendation("intervention_resolved", {
          activityId: activity.id,
          nextSkillId,
          reason: "Respondió correctamente y sin ayuda a los dos reactivos paralelos y a la tarea de transferencia. Puede continuar la ruta; este resultado no certifica dominio.",
          evidence: { ...checkEvidence, transferIndependentItems: transferEvents.length, transferCorrect: transferEvents.filter((event) => event.correct).length }
        });
      }
      return recommendation("teacher_review", {
        activityId: activity.id,
        reason: "La transferencia no se resolvió correctamente de forma independiente. Revisar procedimiento y elegir apoyo adicional; no avanzar automáticamente.",
        evidence: { ...checkEvidence, transferIndependentItems: transferEvents.length, transferCorrect: transferEvents.filter((event) => event.correct).length }
      });
    }

    if (checkEvents.length < decisionRules.postInterventionCheck.parallelItems && nextCheck) {
      return recommendation("post_intervention_check", {
        activityId: activity.id,
        questionId: nextCheck,
        reason: "Presentar un reactivo nuevo de comprobación sin pistas ni solución previa. Esta comprobación evalúa la respuesta inmediata al refuerzo.",
        evidence: checkEvidence
      });
    }
    return recommendation("teacher_review", {
      activityId: activity.id,
      reason: "La comprobación posterior no muestra todavía el criterio esperado o faltan reactivos configurados. Revisar la respuesta y decidir el siguiente apoyo; no repetir automáticamente la misma actividad.",
      evidence: checkEvidence
    });
  }

  const route = gradeRoutes[String(currentGrade)] ?? gradeRoutes.default;
  const routeSkillIds = route.skillIds;
  const skillId = currentSkillId ?? routeSkillIds.find((id) => {
    const stats = summarize(firstIndependentAttempts(prepared, id));
    return stats.n < decisionRules.advance.minIndependentItems || stats.accuracy < decisionRules.advance.minAccuracy;
  }) ?? routeSkillIds.at(-1);
  const skill = skills.find((item) => item.id === skillId);
  if (!skill || !routeSkillIds.includes(skillId)) return recommendation("data_review", { reason: "La habilidad no pertenece a la ruta configurada." });

  const events = firstIndependentAttempts(prepared, skillId);
  const stats = summarize(events);
  const evidence = evidenceFor(skillId, "diagnostic", stats);
  const repeatedError = [...stats.errors.entries()].sort((a, b) => b[1] - a[1])[0];
  if (repeatedError && repeatedError[1] >= decisionRules.errorPattern.minRepeatedErrors) {
    const activity = activities.find((item) => item.targetsSkillId === skillId &&
      item.targetsErrorCodes?.includes(repeatedError[0]) && !completedActivityIds.includes(item.id));
    if (activity) return recommendation("targeted_referral", {
      activityId: activity.id,
      checkQuestionIds: activity.checkQuestionIds,
      reason: `El mismo patrón observable (${repeatedError[0]}) apareció en reactivos independientes distintos. Es una hipótesis de apoyo, no un diagnóstico definitivo.`,
      evidence
    });
  }

  if (stats.n >= decisionRules.support.minIndependentItems && stats.accuracy < decisionRules.support.maxAccuracyExclusive) {
    const activity = activities.find((item) => item.targetsSkillId === skillId && !completedActivityIds.includes(item.id));
    if (activity) return recommendation("supported_practice", {
      activityId: activity.id,
      checkQuestionIds: activity.checkQuestionIds,
      reason: `La evidencia independiente en ${skill.label} está bajo el umbral provisional de práctica con apoyo. Después se aplicará una comprobación distinta.`,
      evidence
    });
  }

  if (stats.n >= decisionRules.advance.minIndependentItems && stats.accuracy >= decisionRules.advance.minAccuracy &&
      stats.formats.size >= decisionRules.advance.minFormats) {
    const nextSkillId = routeSkillIds[routeSkillIds.indexOf(skillId) + 1] ?? null;
    return recommendation(nextSkillId ? "advance" : "route_complete", {
      nextSkillId,
      reason: "La evidencia alcanza los criterios provisionales para recomendar el siguiente paso de esta ruta; no equivale a una certificación de dominio.",
      evidence
    });
  }

  const seenIds = new Set(history.map((event) => event.questionId));
  const nextQuestion = config.questionBank.find((question) => question.skillId === skillId &&
    !question.postInterventionOnly && !seenIds.has(question.id));
  if (!nextQuestion) return recommendation("teacher_review", {
    reason: `Se agotaron los reactivos disponibles para ${skill.label} sin alcanzar evidencia suficiente. Revisar con el docente o ampliar el banco con reactivos equivalentes.`,
    evidence
  });
  return recommendation("collect_evidence", {
    questionId: nextQuestion.id,
    reason: stats.n < decisionRules.minimumEvidence
      ? "Aún no hay evidencia suficiente para decidir; presentar otro reactivo independiente."
      : "El resultado está entre los criterios provisionales; presentar otro reactivo del mismo objetivo y observar el procedimiento.",
    evidence
  });
}
