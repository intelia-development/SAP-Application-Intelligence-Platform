/**
 * ABAP FS Telemetry Service
 * Centralized telemetry collection and storage
 */

import * as vscode from "vscode"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"
import { AppInsightsService } from "./appInsightsService"
import { RemoteManager } from "../config"

interface TelemetryEntry {
  timestamp: string // ISO format
  sessionId: string // Extension session
  userId: string // Anonymous hash
  action: string // "command_xxx_called" or "tool_xxx_called"
  version: string // Extension version
  sapUser: string // SAP username from connection config
}

export class TelemetryService {
  private static instance: TelemetryService
  private sessionId: string
  private userId: string
  private version: string
  private buffer: TelemetryEntry[] = []
  private flushInterval: NodeJS.Timeout | null = null
  private telemetryDir: string
  private isFlushInProgress: boolean = false
  private maxBufferSize: number = 1000

  private constructor(context: vscode.ExtensionContext) {
    // Generate session ID using cryptographically secure random UUID
    this.sessionId = `session-${Date.now()}-${crypto.randomUUID()}`

    // Generate anonymous user ID (hash of machine info)
    const machineInfo = `${os.hostname()}-${os.userInfo().username}-${os.platform()}`
    this.userId = `user-${crypto.createHash("sha256").update(machineInfo).digest("hex").substring(0, 16)}`

    // Get extension version
    this.version =
      vscode.extensions.getExtension("intelia-development.intelia-sap-application-intelligence-platform")?.packageJSON?.version ||
      "unknown"

    // Setup telemetry directory
    this.telemetryDir = path.join(context.globalStorageUri.fsPath, "telemetry")
    this.ensureTelemetryDir()

    // Start periodic flush (every 5 minutes)
    this.startPeriodicFlush()

    // Flush on extension deactivation
    context.subscriptions.push(
      new vscode.Disposable(() => {
        this.flushToFile()
        if (this.flushInterval) {
          clearInterval(this.flushInterval)
        }
      })
    )
  }

  public static initialize(context: vscode.ExtensionContext): void {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService(context)
    }
  }

  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      throw new Error("TelemetryService not initialized. Call initialize() first.")
    }
    return TelemetryService.instance
  }

  /**
   * Log a telemetry event
   * @param action - Action description (e.g., "command_activate_called", "tool_create_test_include_called")
   */
  public log(action: string, sapUser?: string): void {
    const entry: TelemetryEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      userId: this.userId,
      action: action,
      version: this.version,
      sapUser: sapUser || ""
    }

    this.buffer.push(entry)

    // Prevent memory leaks - drop old entries if buffer gets too large
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.maxBufferSize)
    }

    // If buffer gets large, flush immediately (but don't block if already flushing)
    if (this.buffer.length >= 25 && !this.isFlushInProgress) {
      this.flushToFile()
    }
  }

  private ensureTelemetryDir(): void {
    try {
      if (!fs.existsSync(this.telemetryDir)) {
        fs.mkdirSync(this.telemetryDir, { recursive: true })
      }
    } catch (error) {
      console.error("Failed to create telemetry directory:", error)
    }
  }

  private startPeriodicFlush(): void {
    // Flush every 5 minutes
    this.flushInterval = setInterval(
      () => {
        this.flushToFile()
      },
      5 * 60 * 1000
    )
  }

  private flushToFile(): void {
    if (this.buffer.length === 0 || this.isFlushInProgress) return

    // Prevent concurrent flushes
    this.isFlushInProgress = true

    // Copy buffer and clear it immediately to prevent race conditions
    const entriesToFlush = [...this.buffer]
    this.buffer = []

    // Use async operation to prevent blocking
    setImmediate(async () => {
      try {
        const today = new Date().toISOString().split("T")[0] // YYYY-MM-DD
        const filename = `telemetry-${today}.csv`
        const filepath = path.join(this.telemetryDir, filename)

        // Create CSV header if file doesn't exist
        let csvContent = ""
        if (!fs.existsSync(filepath)) {
          csvContent = "timestamp,sessionId,userId,action,version,sapUser\n"
        }

        // Add entries to flush
        for (const entry of entriesToFlush) {
          csvContent += `${entry.timestamp},${entry.sessionId},${entry.userId},${entry.action},${entry.version},${entry.sapUser}\n`
        }

        // Use async write to prevent blocking
        await fs.promises.appendFile(filepath, csvContent, "utf8")
      } catch (error) {
        console.error("Failed to flush telemetry to file:", error)
        // Re-add failed entries to buffer (at the beginning to maintain order)
        this.buffer.unshift(...entriesToFlush)

        // Prevent infinite buffer growth on persistent failures
        if (this.buffer.length > this.maxBufferSize) {
          this.buffer = this.buffer.slice(0, this.maxBufferSize)
        }
      } finally {
        this.isFlushInProgress = false
      }
    })
  }

  /**
   * Log tool result data returned from SAP to a separate JSONL file.
   * Truncates result to 5000 chars to avoid huge files.
   */
  public logToolResult(toolName: string, input: Record<string, unknown>, result: string, sapUser?: string): void {
    const MAX_RESULT_LENGTH = 5000
    const entry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      userId: this.userId,
      version: this.version,
      sapUser: sapUser || "",
      toolName,
      input,
      resultLength: result.length,
      result: result.length > MAX_RESULT_LENGTH ? result.substring(0, MAX_RESULT_LENGTH) + "…[truncated]" : result
    }

    setImmediate(async () => {
      try {
        const today = new Date().toISOString().split("T")[0]
        const filepath = path.join(this.telemetryDir, `tool-results-${today}.jsonl`)
        await fs.promises.appendFile(filepath, JSON.stringify(entry) + "\n", "utf8")
      } catch (error) {
        console.error("Failed to write tool result telemetry:", error)
      }
    })
  }

  /**
   * Get telemetry statistics (for debugging)
   */
  public getStats(): { bufferSize: number; sessionId: string; userId: string; version: string } {
    return {
      bufferSize: this.buffer.length,
      sessionId: this.sessionId,
      userId: this.userId,
      version: this.version
    }
  }
}

/**
 * Convenience function for logging telemetry
 * @param action - Action description (e.g., "command_activate_called", "tool_create_test_include_called")
 */
export function logTelemetry(
  action: string,
  options?: {
    connectionId?: string
    activeEditor?: vscode.TextEditor
    username?: string
  }
): void {
  try {
    // Resolve SAP username from connection config
    const sapUser = options?.connectionId
      ? RemoteManager.get().byId(options.connectionId)?.username || options?.username || ""
      : options?.username || ""

    // Existing CSV logging
    TelemetryService.getInstance().log(action, sapUser)

    // Send to App Insights with context
    AppInsightsService.getInstance().track(action, { ...options, username: sapUser || options?.username })
  } catch (error) {
    // Silently fail - telemetry should never break functionality
    console.error("Telemetry logging failed:", error)
  }
}

/**
 * Log SAP tool result data to a JSONL file.
 * @param toolName - Name of the tool that was executed
 * @param input - Input arguments passed to the tool
 * @param result - Raw text result returned from SAP
 * @param connectionId - Optional connection ID to resolve SAP username
 */
export function logToolResult(
  toolName: string,
  input: Record<string, unknown>,
  result: string,
  connectionId?: string
): void {
  try {
    const sapUser = connectionId
      ? RemoteManager.get().byId(connectionId)?.username || ""
      : (typeof input["connectionId"] === "string"
          ? RemoteManager.get().byId(input["connectionId"] as string)?.username || ""
          : "")
    TelemetryService.getInstance().logToolResult(toolName, input, result, sapUser)
  } catch (error) {
    console.error("Tool result telemetry logging failed:", error)
  }
}
