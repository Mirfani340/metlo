import dotenv from "dotenv"
dotenv.config()

import express, { Express, Request, Response } from "express"
import { AppDataSource } from "data-source"
import { verifyApiKeyMiddleware } from "middleware/verify-api-key-middleware"
import { bodyParserMiddleware } from "middleware/body-parser-middleware"
import { MetloRequest } from "types"
import { getRepoQB } from "services/database/utils"
import registerLoggingRoutes from "api/collector"

const app: Express = express()
const port = process.env.PORT || 8081
const router = express.Router()

app.disable("x-powered-by")
app.use(async (req: MetloRequest, res, next) => {
  req.ctx = {}
  next()
})

app.get("/api/v1", (req: Request, res: Response) => {
  res.send("OK")
})

app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ limit: "10mb", extended: true }))
app.use(verifyApiKeyMiddleware)
app.use(bodyParserMiddleware)
app.use("/api/v1", router)

registerLoggingRoutes(router)

const main = async () => {
  try {
    const datasource = await AppDataSource.initialize()
    console.log(
      `Is AppDataSource Initialized? ${
        datasource.isInitialized ? "Yes" : "No"
      }`,
    )
    app.listen(port, () => {
      console.log(`⚡️[server]: Server is running at http://localhost:${port}`)
    })
  } catch (err) {
    console.error(`CatchBlockInsideMain: ${err}`)
  }
}

main().catch(err => {
  console.error(`Error in main try block: ${err}`)
})
