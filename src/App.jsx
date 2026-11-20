import { useState } from 'react'
import curriculumData from './adaptive/curriculum-data.json'
import { decideNext } from './adaptive/adaptive-engine.js'
import './App.css'

const firstQuestion = curriculumData?.questionBank?.[0] ?? null
const actionLabels = {
  collect_evidence: 'Recopilar más evidencia',
}

function normalizeAnswer(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('es-MX')
    .replace(/[−–—]/g, '-')
    .replace(/\s+/g, '')
    .replace(/[.,]$/, '')
}

function isCorrectAnswer(question, response) {
  const acceptedAnswers = [question.answer, ...(question.acceptedAnswers ?? [])]
  const normalizedResponse = normalizeAnswer(response)
  return acceptedAnswers.some((answer) => normalizeAnswer(answer) === normalizedResponse)
}

function App() {
  const [response, setResponse] = useState('')
  const [submission, setSubmission] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')

  if (!firstQuestion) {
    return (
      <main className="aa-page">
        <div className="aa-container">
          <h1>Aula Adaptativa</h1>
          <p role="alert">No se encontró un reactivo en la configuración del motor.</p>
        </div>
      </main>
    )
  }

  const choices = Array.isArray(firstQuestion.choices) ? firstQuestion.choices : []

  function handleSubmit(event) {
    event.preventDefault()
    if (!response.trim() || submission) return

    const evidenceEvent = {
      questionId: firstQuestion.id,
      correct: isCorrectAnswer(firstQuestion, response),
      response,
      attemptNumber: 1,
      hintCount: 0,
      feedbackSeen: false,
      workedExampleSeen: false,
      supportLevel: 0,
      phase: 'diagnostic',
      timestamp: new Date().toISOString(),
    }

    try {
      const decision = decideNext({
        history: [evidenceEvent],
        currentGrade: 1,
        currentSkillId: firstQuestion.skillId,
        completedActivityIds: [],
        pendingIntervention: null,
        config: curriculumData,
      })
      setSubmission({ event: evidenceEvent, decision })
      setErrorMessage('')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'No se pudo procesar la respuesta.')
      setSubmission(null)
    }
  }

  return (
    <main className="aa-page">
      <div className="aa-container">
        <header className="aa-header">
          <p className="aa-eyebrow">Matemáticas · Secundaria</p>
          <h1>Aula Adaptativa</h1>
          <p className="aa-intro">Resuelve este reactivo para iniciar la revisión de tus conocimientos.</p>
        </header>

        <section className="aa-card" aria-labelledby="diagnostic-title">
          <div className="aa-card-heading">
            <span className="aa-step">Reactivo 1</span>
            <span className="aa-skill">{curriculumData.skills.find((skill) => skill.id === firstQuestion.skillId)?.label ?? firstQuestion.skillId}</span>
          </div>
          <h2 id="diagnostic-title">Pregunta diagnóstica</h2>
          <p className="aa-prompt">{firstQuestion.prompt}</p>

          <form onSubmit={handleSubmit}>
            {choices.length > 0 ? (
              <fieldset className="aa-choices" disabled={Boolean(submission)}>
                <legend className="aa-sr-only">Elige una respuesta</legend>
                {choices.map((choice) => (
                  <label className="aa-choice" key={choice}>
                    <input
                      type="radio"
                      name="diagnostic-answer"
                      value={choice}
                      checked={response === choice}
                      onChange={(event) => setResponse(event.target.value)}
                    />
                    <span>{choice}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <div className="aa-answer-field">
                <label htmlFor="diagnostic-answer">Tu respuesta</label>
                <input
                  id="diagnostic-answer"
                  type="text"
                  value={response}
                  onChange={(event) => setResponse(event.target.value)}
                  disabled={Boolean(submission)}
                  autoComplete="off"
                  required
                />
              </div>
            )}

            <button className="aa-submit" type="submit" disabled={!response.trim() || Boolean(submission)}>
              Enviar respuesta
            </button>
          </form>
        </section>

        {errorMessage && <p className="aa-error" role="alert">No se pudo procesar la respuesta: {errorMessage}</p>}

        {submission && (
          <section className="aa-result" aria-labelledby="recommendation-title" aria-live="polite">
            <p className="aa-eyebrow">Respuesta registrada</p>
            <h2 id="recommendation-title">Recomendación del motor</h2>
            <p><strong>Acción:</strong> {actionLabels[submission.decision.action] ?? submission.decision.action}</p>
            <p>{submission.decision.reason}</p>

            {submission.decision.questionId && (
              <p className="aa-next-question">
                El motor propone como siguiente reactivo: <code>{submission.decision.questionId}</code>.
              </p>
            )}

            {submission.decision.evidence && (
              <dl className="aa-evidence">
                <div><dt>Reactivos independientes</dt><dd>{submission.decision.evidence.independentItems ?? 0}</dd></div>
                <div><dt>Respuestas correctas</dt><dd>{submission.decision.evidence.correct ?? 0}</dd></div>
                <div><dt>Precisión observada</dt><dd>{submission.decision.evidence.accuracy === null || submission.decision.evidence.accuracy === undefined ? 'Sin datos' : `${Math.round(submission.decision.evidence.accuracy * 100)}%`}</dd></div>
              </dl>
            )}

            <p className="aa-limit-note">Esta es una recomendación basada en la evidencia de este intento; no certifica dominio.</p>
            <details className="aa-event-details">
              <summary>Ver registro de evidencia</summary>
              <pre>{JSON.stringify(submission.event, null, 2)}</pre>
            </details>
          </section>
        )}
      </div>
    </main>
  )
}

export default App
