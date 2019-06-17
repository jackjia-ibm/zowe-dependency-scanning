/*
* This program and the accompanying materials are made available under the terms of the *
* Eclipse Public License v2.0 which accompanies this distribution, and is available at *
* https://www.eclipse.org/legal/epl-v20.html                                      *
*                                                                                 *
* SPDX-License-Identifier: EPL-2.0                                                *
*                                                                                 *
* Copyright Contributors to the Zowe Project.                                     *
*                                                                                 *
*/

import * as async from "async";
import * as spawn from "cross-spawn";
import * as fs from "fs";
import { inject, injectable } from "inversify";
import * as path from "path";
import "reflect-metadata";
import * as rimraf from "rimraf";
import { Constants } from "../constants/Constants";
import { TYPES } from "../constants/Types";
import { Logger } from "../utils/Logger";
import { Utilities } from "../utils/Utilities";
import { IAction } from "./IAction";


@injectable()
export class ReportActon implements IAction {

    @inject(TYPES.Logger) private readonly log: Logger;
    @inject(TYPES.RepoRules) private readonly repoRules: any;

    private readonly TABLE_HEADER =
        `| Component | Third-party Software | Version | License | GitHub |\n` +
        `| ----------| -------------------- | --------| ------- | ------ |`;
    private readonly componentMap = JSON.parse(fs.readFileSync(Constants.COMPONENT_MAP_FILE).toString());
    private readonly REPORT_MARKDOWN_FILE = path.resolve(Constants.REPORTS_DIR, "markdown_dependency_report.md");
    private reportQueue: async.AsyncQueue<any> = async.queue(this.reportProject.bind(this), Constants.PARALLEL_REPORT_COUNT);

    constructor() {
        console.log("Making dir " + Constants.REPORTS_DIR);
        if (Constants.CLEAN_REPO_DIR_ON_START && (Constants.EXEC_REPORTS || Constants.EXEC_SCANS)) {
            rimraf.sync(Constants.REPORTS_DIR);
        }
        if (!fs.existsSync(Constants.REPORTS_DIR)) {
            fs.mkdirSync(Constants.REPORTS_DIR, { recursive: true });
        }
        this.completeMarkdownReport.bind(this);
    }

    /**
     * downloadRepositories - from <root>/resources/repos.json
     */
    public run(): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            if (Constants.EXEC_REPORTS) {

                console.log("Generate Report");
                const projectDirs: string[] = Utilities.getSubDirs(Constants.CLONE_DIR);
                const rulesDirs = this.repoRules.getExtraProjectPaths(projectDirs);
                // As compared to other actions, we do not fully resolve project dirs. We will use the project dir as the name i
                this.reportQueue.push(projectDirs);
                this.reportQueue.push(rulesDirs);
                this.reportQueue.drain = () => {
                    this.completeMarkdownReport().then((reportDone) => {
                        resolve(true);
                    }).catch((error) => {
                        reject(error);
                    });
                };
            }

        });
    }

    private completeMarkdownReport(): Promise<any> {
        return new Promise((resolve, reject) => {
            const sortedComponentMap: any = {};
            Object.keys(this.componentMap).sort().forEach((key) => { sortedComponentMap[key] = this.componentMap[key]; });

            const reportFile = fs.createWriteStream(this.REPORT_MARKDOWN_FILE, { flags: "a" });
            reportFile.write("# Zowe Third Party Library Usage\n\n");

            Object.keys(sortedComponentMap).forEach((component) => {
                reportFile.write("* [" + component + "](#" + component.replace(/\s/g, "-").toLowerCase()
                    + "-dependency-attributions)" + "\n");
            });
            reportFile.write("\n");
            Object.keys(sortedComponentMap).forEach((component) => {
                const reports = sortedComponentMap[component];
                let totalDepCt = 0;
                let missingReport: boolean = false;
                let fullReportString = "### " + component + " Dependency Attributions " + "\n" + this.TABLE_HEADER + "\n";
                reports.forEach((reportInstance: string) => {
                    try {
                        fs.statSync(path.join(Constants.REPORTS_DIR, `${reportInstance}.md`));
                        const lines: string[] = fs.readFileSync(path.join(Constants.REPORTS_DIR, `${reportInstance}.md`), "utf-8")
                            .split("\n").filter(Boolean);
                        const reportDepCt = lines.length;
                        if (reportDepCt > 0) {
                            totalDepCt += reportDepCt;
                            fullReportString = fullReportString + lines.join("\n").replace(new RegExp(reportInstance, "g"), component);
                        }
                    }
                    catch {
                        console.log("INFO: Missing file " + reportInstance + ".md");
                        missingReport = true;
                    }
                });
                if (totalDepCt > 0) {
                    reportFile.write(fullReportString);
                    reportFile.write("\n\n");
                }
                else if (!missingReport && totalDepCt <= 0){
                    console.log(component + " is empty");
                }
            });
            resolve(true);
        });
    }

    private reportProject(projectPath: string, cb: (error: any, val?: any) => void) {

        const resolvedDir = path.join(Constants.CLONE_DIR, projectPath);
        const normalizedProjectName = projectPath.replace(/[\\\/]/g, "-");
        console.log("Running license_finder report on " + resolvedDir);
        const reportProcess = spawn("license_finder", ["report", "--format", "markdown_table",
            "--project-path", resolvedDir,
            "--project-name", normalizedProjectName,
            "--save", path.join(Constants.REPORTS_DIR, `${normalizedProjectName}.md`),
            "--decisions-file=" + Constants.DEPENDENCY_DECISIONS_YAML], {
                cwd: process.env.cwd,
                env: process.env,
                // Shell true required for aggregate paths with spaces between projects
                shell: true
            });
        const logPromise: Promise<any> = this.log.logOutputAsync(reportProcess, projectPath, "report");
        logPromise.then((result) => {
            cb(null, result);
            if (result !== 0) {
                // TODO: do something in fail state?
            }
        }).catch((error) => {
            cb(error, null);
            console.log(error);
        });

    }

}
