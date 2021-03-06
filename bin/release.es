#!/usr/bin/env escript
%%! -smp disable -env ERL_CRASH_DUMP /dev/null +sbtu +A0 -mode minimal -boot start_clean -pa ebin -pa deps/lager/ebin -pa deps/util/ebin -pa deps/goldrush/ebin

%%-------------------------------------------------------------------
%% This script creates a release file given a release template file.
%% The template should be in the standard *.rel file format. All
%% versions of applications will be replaced by current versions
%% of the applications found in the installed Erlang distribution.
%%
%% Assuming that you need to build a boot file containing
%% applications found in "./ebin" and "deps/*/ebin" directories, you
%% can include the following make targets for building the boot file:
%%
%% ```
%% EBIN_DEPS=ebin $(wildcard deps/*/ebin)
%% LIB_ARGS=$(EBIN_DEPS:%=-pa %)
%%
%% priv/release.es:
%%     curl -s https://raw.github.com/saleyn/util/master/bin/release.es | \
%%     awk '/^%%!/ { print "%%! $(LIB_ARGS)" } !/^%%!/ {print}' > $@
%%
%% priv/myapp.rel: src/myapp.template.rel priv/release.es
%%     escript priv/release.es $< $@
%%
%% priv/myapp.boot: priv/myapp.rel
%%     erlc $(LIB_ARGS) -o $(@D) $<
%% ```
%%-------------------------------------------------------------------
-mode(compile).

-include_lib("sasl/src/systools.hrl").

main([TemplateRelFile, OutRelFile]) ->
    create_release_file(TemplateRelFile, OutRelFile, undefined);
main(_) ->
	io:format("Usage: ~s TemplateRelFile OutRelFile\n\n"
	          "    Example:\n"
		  "        ~s myapp.rel.src ./ebin/myapp.rel\n",
		  [escript:script_name(), escript:script_name()]),
	halt(1).

%%-------------------------------------------------------------------
%% @spec create_release_file(TemplateRelFile, OutRelFile, Vsn) -> ok
%%          TemplateRelFile = filename()
%%          OutRelFile      = filename()
%%          Vsn             = string()
%% @doc Create a release file given a release template file.  The
%%      release template file should have the same structure as the
%%      release file.  This function will ensure that latest
%%      application versions are included in the release.  It will
%%      also ensure that the latest erts version is specified in
%%      the release file.  Note that both arguments may contain the
%%      ".rel" extension, however the actual TemplateRelFile must
%%      have a ".rel" extension.  The TemplateRelFile doesn't need
%%      to contain application version numbers - an empty string will
%%      do: <code>{kernel, ""}</code>.  This function will populate
%%      the version number with current version of the application.
%%      ``Vsn'' is the version number associated with the generated
%%      release file.  If it is ``undefined'', the version from the
%%      ``TemplateRelFile'' will be used.
%% ```
%% Example:
%%   create_release_file("myapp.rel.src", "./ebin/myapp.rel").
%% '''
%% @end
%%-------------------------------------------------------------------
create_release_file(TemplateRelFile, OutRelFile, Vsn) ->
    Template = strip_ext(TemplateRelFile),
	try
        create_file_link(Template, TemplateRelFile),
		Rel = get_release(Template),
		write_file(Template, OutRelFile, Rel, Vsn)
	catch _:Error ->
		io:format("Error: ~p\n  ~p\n", [Error, erlang:get_stacktrace()]),
		init:stop(1)
    after
        remove_file_link(Template)
	end.

write_file(TemplateRelFile, OutRelFile, Rel, Vsn) ->
    OutFileName = filename:join(filename:dirname(OutRelFile),
                                filename:basename(OutRelFile,".rel")++".rel"),
    case file:open(OutFileName, [write]) of
    {ok, FD} ->
        io:format(FD, "%%%~n"
                      "%%% This file is automatically generated from ~s~n"
                      "%%%~n~n", [TemplateRelFile]),
        io:format(FD, "{release, {~p, ~p}, {erts, ~p},~n  [~n~s  ]~n}.~n",
                  [Rel#release.name,
                   case Vsn of
                   undefined -> Rel#release.vsn;
                   _         -> Vsn
                   end,
                   Rel#release.erts_vsn,
                   format_list(Rel#release.applications)]),
        file:close(FD);
    {error, Reason} ->
        throw({error, file:format_error(Reason)})
    end.

get_release(Filename) ->
    File = filename:basename(Filename, ".rel"),
    Dir  = [filename:dirname(Filename) | code:get_path()],
    {ok, Release, _} = systools_make:read_release(File, Dir),
    case systools_make:get_release(File, Dir) of
    {ok, Rel, _, _} ->
        Rel#release{erts_vsn = erlang:system_info(version)};
    {error,systools_make,List} ->
        NewList =
            lists:foldl(fun({error_reading,{Mod,{not_found,AppFile}}}, {Ok, Err}) ->
                            {Ok, [{not_found, {Mod, AppFile}} | Err]};
                        ({error_reading,{Mod,{no_valid_version,
                                {{"should be",_}, {"found file", _, Vsn}}}}}, {Ok, Err}) ->
                            {[{Mod, Vsn} | Ok], Err}
                        end, {[],[]}, List),
        case NewList of
        {ModVsn, []} ->
            substitute_versions(Release, ModVsn);
        {_, ErrMod} ->
            throw({error, ErrMod})
        end
    end.

substitute_versions(Release, []) ->
	Release;
substitute_versions(Release, [{Mod, Vsn} | Tail]) ->
    Apps = Release#release.applications,
    NewApps =
        case lists:keysearch(Mod, 1, Apps) of
        {value, {Mod, _Vsn, Type}} ->
            lists:keyreplace(Mod, 1, Apps, {Mod, Vsn, Type});
        false ->
            Apps
        end,
    substitute_versions(Release#release{applications = NewApps,
                                        erts_vsn     = erlang:system_info(version)}, Tail).

format_list(A) ->
    {LN, LV} =
        lists:foldl(fun({N,V,_}, {L1, L2}) ->
                        {erlang:max(L1, length(atom_to_list(N))),
                         erlang:max(L2, length(V))}
                    end, {0,0}, A),
    format_list(A, [], {LN, LV}).
format_list([], [$\n, $, | Acc], _) ->
    lists:reverse([$\n | Acc]);
format_list([{App,Vsn,permanent} | Tail], Acc, {LN, _LA} = Len) ->
    Str = lists:flatten(io_lib:format("    {~-*w, ~s},~n", [LN, App, [$"]++Vsn++[$"]])),
    format_list(Tail, lists:reverse(Str) ++ Acc, Len);
format_list([{App,Vsn,Type} | Tail], Acc, {LN, LA} = Len) ->
    Str = lists:flatten(io_lib:format("    {~-*w, ~-*s, ~p},~n", [LN, App, LA+2, [$"]++Vsn++[$"], Type])),
    format_list(Tail, lists:reverse(Str) ++ Acc, Len).

strip_ext(Filename) ->
    case filename:extension(Filename) of
    ".rel" ->
        Filename;
    ".src" ->
        filename:join(
            filename:dirname(Filename),
            filename:basename(Filename, ".src"))
    end.

create_file_link(Filename, Filename) ->
    ok;
create_file_link(File, Filename) ->
    case file:read_link(File) of
    {ok, _} -> ok;
    _       ->
        Cmd = "ln -s -r " ++ Filename ++ " " ++ File,
        case os:cmd(Cmd) of
        []  -> ok;
        _   ->
            %% Most likely can't created links on this filesystem
            [] = os:cmd("cp " ++ Filename ++ " " ++ File)
        end
    end.

remove_file_link(File) ->
    case file:read_link(File) of
    {ok, _} -> file:delete(File);
    _       -> ok
    end.
